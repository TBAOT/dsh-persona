/**
 * dsh-persona — topic library (Host half).
 *
 * The two resident files keep what is always worth reading: who the user is,
 * and the rules this persona works by. Everything else — how a queue was
 * rebuilt, where a document lives, what a migration script does — is detail.
 * Detail goes here, one Markdown file per subject, and the prompt only carries
 * an index line per subject (slug + summary + path). The model opens the file
 * when it actually needs it, the same way private skills work.
 *
 * Markdown stays the source of truth: readable, diffable, hand-editable. Any
 * index built on top of it is disposable.
 */
import { promises as fs } from 'node:fs'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { inspectContent, personaDir } from './store.js'

/** One topic file is detail, not a dump: past this it should split. */
export const TOPIC_MAX_CHARS = 4000
/** The prompt index shows one line per topic; keep it one line. */
export const TOPIC_SUMMARY_MAX = 60

const ASCII_SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/
const CJK_SLUG = /^[\u4e00-\u9fa5]{2,12}$/

export function topicsDir(id, env = process.env) {
  return path.join(personaDir(id, env), 'topics')
}

/** A slug is either ascii-kebab or 2–12 Chinese characters; anything else is derived. */
export function slugify(input) {
  const raw = String(input ?? '').trim()
  if (ASCII_SLUG.test(raw) || CJK_SLUG.test(raw)) return raw
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (ASCII_SLUG.test(ascii)) return ascii
  if (CJK_SLUG.test(ascii)) return ascii
  return ascii ? ascii.slice(0, 40) : 'untitled'
}

function parseFrontMatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { meta: {}, body: String(text) }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const hit = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/)
    if (hit) meta[hit[1]] = hit[2].trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: String(text).slice(match[0].length) }
}

/** Slug for an entry that overflowed the resident tier: no model hint, so derive one. */
export function autoSlug(content) {
  const text = String(content ?? '').replace(/[`~!@#$%^&*()+=\[\]{};:'",.<>/?\\|，。、；：？！…—－「」『』（）【】《》]/g, ' ')
  const compact = text.replace(/\s+/g, '').slice(0, 12)
  return slugify(compact || 'overflow')
}
export function readTopic(file) {
  const text = readFileSync(file, 'utf8')
  const { meta, body } = parseFrontMatter(text)
  return {
    slug: meta.slug || path.basename(file, '.md'),
    summary: meta.summary || '',
    updated: meta.updated || '',
    body,
    chars: text.length,
    path: file,
  }
}

/** Every topic of one persona, newest first. Missing directory is not an error. */
export function listTopicsSync(id, env = process.env) {
  const dir = topicsDir(id, env)
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    try {
      out.push(readTopic(path.join(dir, entry.name)))
    } catch {
      /* a broken file must not take the whole index down */
    }
  }
  return out.sort((left, right) => String(right.updated).localeCompare(String(left.updated)))
}

/** Token overlap used to decide "this is the same subject". */
export function overlap(left, right) {
  const tokenize = (text) =>
    new Set(
      String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .flatMap((word) => (word.length <= 2 ? [word] : Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)))),
    )
  const a = tokenize(left)
  const b = tokenize(right)
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/**
 * Write one topic. Existing subjects are appended to (never overwritten), and
 * an identical paragraph is skipped instead of duplicated.
 */
/** A topic whose file has not changed for `ttlDays` stops being injected (mem0's filter, not a delete). */
export function isTopicExpired(topic, ttlDays, today = new Date().toISOString().slice(0, 10)) {
  const days = Number(ttlDays ?? 0)
  if (!days) return false
  const updated = String(topic?.updated ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) return false
  const deadline = new Date(Date.parse(updated) + days * 86400000).toISOString().slice(0, 10)
  return deadline < today
}

/** Retire a topic without destroying it: the file moves into topics/archive/. */
export async function archiveTopic(id, slug, env = process.env) {
  const safe = slugify(slug)
  if (!safe) return { ok: false, error: '缺少 slug' }
  const from = path.join(topicsDir(id, env), `${safe}.md`)
  if (!existsSync(from)) return { ok: false, error: `没有这个主题：${safe}` }
  const dir = path.join(topicsDir(id, env), 'archive')
  await fs.mkdir(dir, { recursive: true })
  const to = path.join(dir, `${safe}-${new Date().toISOString().slice(0, 10)}.md`)
  await fs.rename(from, to)
  await writeTopicManifest(id, env).catch(() => {})
  return { ok: true, slug: safe, archived: to }
}
export async function writeTopic(id, input, env = process.env) {
  const slug = slugify(input?.slug)
  const content = String(input?.content ?? '').trim()
  if (!content) return { ok: false, error: '内容为空' }
  const check = inspectContent(content)
  if (!check.ok) return { ok: false, error: check.error }

  const dir = topicsDir(id, env)
  const file = path.join(dir, `${slug}.md`)
  const exists = existsSync(file)
  const previous = exists ? readTopic(file) : { body: '', summary: '', updated: '' }
  if (previous.body.includes(content)) {
    return { ok: true, path: file, slug, chars: previous.chars, skipped: true }
  }

  const summary = String(input?.summary ?? previous.summary ?? '').slice(0, TOPIC_SUMMARY_MAX)
  const stamp = String(input?.updated ?? new Date().toISOString().slice(0, 10))
  const heading = `## ${stamp}`
  const body = `${previous.body.trim() ? `${previous.body.trim()}\n\n` : ''}${heading}\n\n${content}\n`
  const next = `---\nslug: ${slug}\nsummary: ${summary}\nupdated: ${stamp}\n---\n\n${body}`

  if (next.length > TOPIC_MAX_CHARS) {
    return { ok: false, error: `主题「${slug}」已满：${next.length}/${TOPIC_MAX_CHARS} 字符，请拆分或先精简` }
  }

  await fs.mkdir(dir, { recursive: true })
  const temp = `${file}.tmp`
  await fs.writeFile(temp, next, 'utf8')
  await fs.rename(temp, file)
  return { ok: true, path: file, slug, chars: next.length, created: !exists }
}

/** Rebuild the disposable index manifest from the topic files themselves. */
export async function writeTopicManifest(id, env = process.env) {
  const topics = listTopicsSync(id, env)
  const dir = path.join(personaDir(id, env), 'memory', 'index')
  const manifest = {
    version: 1,
    builtAt: new Date().toISOString(),
    count: topics.length,
    chars: topics.reduce((sum, topic) => sum + topic.chars, 0),
    topics: topics.map((topic) => ({
      slug: topic.slug,
      summary: topic.summary,
      updated: topic.updated,
      chars: topic.chars,
      path: topic.path,
    })),
  }
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { count: manifest.count, chars: manifest.chars }
}

/** Render the prompt index: one line per topic, trimmed to a character budget. */
export function renderTopicIndex(topics, limit = 350) {
  if (!topics.length) return ''
  // The directory is stated once, in the header: per-line absolute paths ate the
  // whole budget (8 topics already overflowed 350 chars and hid 5 of them).
  const dir = topics[0]?.path ? topics[0].path.replace(/[\\/][^\\/]+$/, '') : ''
  const header = dir ? `目录：${dir}` : ''
  const lines = header ? [header] : []
  let used = header ? header.length + 1 : 0
  let shown = 0
  const formatLine = (topic) => {
    const summary = String(topic.summary ?? '').replace(/\s+/g, ' ').slice(0, 30) || '(无摘要)'
    return `- ${topic.slug}｜${summary}`
  }
  // Newest first: when the budget runs out, whatever just changed stays visible.
  const ordered = [...topics].sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
  for (const topic of ordered) {
    const line = formatLine(topic)
    if (used + line.length + 1 > limit) break
    lines.push(line)
    used += line.length + 1
    shown += 1
  }
  if (!shown) {
    // Never render nothing: at least one pointer, truncated to fit.
    const head = formatLine(ordered[0]).slice(0, Math.max(0, limit - 12))
    return `${head}\n（另有 ${ordered.length} 个主题未列出）`
  }
  const omitted = ordered.length - shown
  return `${lines.join('\n')}${omitted > 0 ? `\n（另有 ${omitted} 个主题未列出）` : ''}`
}
