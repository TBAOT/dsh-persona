/**
 * dsh-persona — storage layer.
 *
 * A persona lives on disk as plain Markdown, one entry per block, separated by
 * a lone `§` line (the same convention Hermes uses, so entries stay readable
 * and diff-friendly). Nothing here touches the network or the harness: every
 * function is either a pure string transform or a small file read/write, which
 * keeps the plugin testable without a running Host.
 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const SEPARATOR = '\n§\n'
export const HEADER_PREFIX = '<!-- dsh-persona v1 target='

/** Character budgets. Overridable through plugin config; these are the defaults. */
export const DEFAULT_LIMITS = {
  user: 1375,
  memory: 2200,
}

/** Targets an operation may name. */
export const TARGETS = ['user', 'memory']

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
]

export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return fromEnv || path.join(os.homedir(), '.dsh')
}

export function sanitizeId(value, fallback = 'default') {
  const id = String(value ?? '').trim().toLowerCase()
  return ID_PATTERN.test(id) ? id : fallback
}

export function personaDir(id, env = process.env) {
  return path.join(resolveDshHome(env), 'personas', sanitizeId(id))
}

export function memoryFile(id, target, env = process.env) {
  return path.join(personaDir(id, env), 'memory', `${target}.md`)
}

export function topicFile(id, topic, env = process.env) {
  return path.join(personaDir(id, env), 'memory', 'topics', `${sanitizeId(topic, 'topic')}.md`)
}

/** Split one stored file into its entries. */
export function parseEntries(text) {
  const raw = String(text ?? '')
  if (!raw.trim()) return []
  const body = raw
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith(HEADER_PREFIX))
    .join('\n')
  return body
    .split(/\r?\n§\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/** Render entries back into a stored file, header first. */
export function formatEntries(target, entries) {
  const header = `${HEADER_PREFIX}${target} -->`
  const body = entries.map((entry) => entry.trim()).filter(Boolean).join(SEPARATOR)
  return body ? `${header}\n${body}\n` : `${header}\n`
}

export function totalChars(entries) {
  return entries.reduce((sum, entry) => sum + entry.length, 0) + Math.max(0, entries.length - 1) * SEPARATOR.length
}

export function usage(entries, limit) {
  const used = totalChars(entries)
  const percent = limit > 0 ? Math.round((used / limit) * 100) : 0
  return { used, limit, percent, remaining: Math.max(0, limit - used) }
}

/** Reject content that could poison the prompt or leak secrets. */
export function inspectContent(content) {
  const text = String(content ?? '')
  if (!text.trim()) return { ok: false, error: '内容为空' }
  if (INVISIBLE.test(text)) return { ok: false, error: '内容包含不可见 Unicode 字符，已拒绝' }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) return { ok: false, error: '内容疑似包含密钥或私钥，已拒绝' }
  }
  return { ok: true }
}

function findMatches(entries, oldText) {
  const needle = String(oldText ?? '')
  if (!needle) return []
  const hits = []
  entries.forEach((entry, index) => {
    let from = 0
    for (;;) {
      const at = entry.indexOf(needle, from)
      if (at < 0) break
      hits.push({ index, at })
      from = at + needle.length
    }
  })
  return hits
}

/**
 * Apply one operation to an entry list. Pure: returns a new list or an error.
 * `op` is `{ action, content, old_text }`.
 */
/** Character hash used as the join key between an entry and its metadata/evidence. */
export function entryHash(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 12)
}

/** Token-set similarity: CJK as 2-grams, latin as words. 1 means identical vocabulary. */
export function similarity(left, right) {
  const tokenize = (text) => {
    const set = new Set()
    for (const word of String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)) {
      if (/^[a-z0-9]+$/.test(word)) {
        set.add(word)
        continue
      }
      if (word.length <= 2) set.add(word)
      else for (let index = 0; index < word.length - 1; index += 1) set.add(word.slice(index, index + 2))
    }
    return set
  }
  const a = tokenize(left)
  const b = tokenize(right)
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/** Above this, a new entry is treated as a rewrite of the existing one. */
export const MERGE_SIMILARITY = 0.8

/**
 * One resident entry is one fact, written as a single sentence.
 *
 * Not a number invented here: mem0's extractor asks for 15–80 word self-contained
 * statements, and generative agents store one sentence per node. 120 CJK characters
 * is that same fact, with the conditions kept — short enough that 3000 characters
 * still hold ~25 facts, long enough not to lose "when does this apply".
 */
export const ENTRY_MAX_CHARS = 120

const overlongHint = (length) =>
  `这条 ${length} 字，超过单条 ${ENTRY_MAX_CHARS} 字上限：请压成一句话（结论或判据，保留"什么情况适用"），过程、命令、对照数据写进 topic`

export function applyOperation(entries, op) {
  const action = String(op?.action ?? '')
  const content = String(op?.content ?? '')

  if (action === 'add') {
    const check = inspectContent(content)
    if (!check.ok) return { ok: false, error: check.error }
    const normalized = content.trim()
    if (normalized.length > ENTRY_MAX_CHARS) return { ok: false, error: overlongHint(normalized.length) }
    if (entries.some((entry) => entry.trim() === normalized)) {
      return { ok: false, error: '已有完全相同的条目，未重复添加' }
    }
    const twin = entries.findIndex((entry) => similarity(entry, normalized) >= MERGE_SIMILARITY)
    if (twin >= 0) {
      const next = [...entries]
      const replaced = next[twin]
      next[twin] = normalized
      // A rewrite that looks like an add must not be silent: the caller reports it
      // and keeps the old text, so "where did my rule go" is answerable.
      return { ok: true, entries: next, mergedInto: entryHash(replaced), replacedText: replaced }
    }
    return { ok: true, entries: [...entries, normalized] }
  }

  if (action === 'patch') {
    const check = inspectContent(content)
    if (!check.ok) return { ok: false, error: check.error }
    const oldText = String(op?.old_text ?? '')
    const preview = findMatches(entries, oldText)
    if (preview.length === 1) {
      // The review model regularly hands the whole entry back as `content`, which
      // turns "replace this clause" into "write the clause twice". Substring
      // containment is not the tell ('pnpm' contains 'npm'); repeating the text
      // *around* the match is.
      const entry = entries[preview[0].index]
      const at = preview[0].at
      const before = entry.slice(0, at).trim()
      const after = entry.slice(at + oldText.length).trim()
      const repeatsContext = (before.length >= 6 && content.includes(before)) || (after.length >= 6 && content.includes(after))
      if (repeatsContext) {
        return { ok: false, error: 'content 复述了 old_text 前后的原文，会把句子写两遍；patch 只给替换后的新措辞' }
      }
    }
    const hits = findMatches(entries, oldText)
    if (hits.length === 0) return { ok: false, error: '没有条目包含 old_text，无法修改' }
    if (hits.length > 1) return { ok: false, error: `old_text 命中 ${hits.length} 处，请提供更长的唯一片段` }
    const { index, at } = hits[0]
    const next = [...entries]
    const before = next[index]
    next[index] = entries[index].slice(0, at) + content + entries[index].slice(at + String(op.old_text).length)
    // The 120-character cap binds on `add` and on `rethink`; a patch is how an
    // existing (possibly legacy) entry gets shorter, so it is not capped here — the
    // tier-level limit below still applies.
    return { ok: true, entries: next, replacedInto: entryHash(before), replacementHash: entryHash(next[index]) }
  }

  if (action === 'remove') {
    const hits = findMatches(entries, op?.old_text)
    if (hits.length === 0) return { ok: false, error: '没有条目包含 old_text，无法删除' }
    const indexes = [...new Set(hits.map((hit) => hit.index))]
    if (indexes.length > 1) return { ok: false, error: 'old_text 命中多个条目，请提供更长的唯一片段' }
    const next = entries.filter((_, index) => index !== indexes[0])
    return { ok: true, entries: next }
  }

  return { ok: false, error: `未知操作：${action || '(空)'}` }
}

/** Default warning line: past this share of the limit, new entries are refused. */
export const DEFAULT_ROUTE_THRESHOLD = 0.9

/**
 * Whole-tier rewrite, for the background consolidation pass.
 *
 * Modelled on Letta's `memory_rethink`, which the source keeps out of the chat tool
 * set and gives only to the sleep-time agent: a conversation may edit precisely, it
 * may not sweep the shelf while the user is watching. Deliberately NOT wired into
 * the `memory` tool — only the consolidation pass calls it.
 */
export function applyRethink(entries, content, limit, options = {}) {
  const lines = String(content ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)
  if (!lines.length) return { ok: false, error: 'rethink 内容为空：请给出整层的新条目，一行一条' }
  const tooLong = lines.find((line) => line.length > ENTRY_MAX_CHARS)
  if (tooLong) return { ok: false, error: overlongHint(tooLong.length) }
  const seen = new Set()
  for (const line of lines) {
    const check = inspectContent(line)
    if (!check.ok) return { ok: false, error: check.error }
    if (seen.has(line)) return { ok: false, error: `rethink 出现重复条目：${line.slice(0, 30)}…` }
    seen.add(line)
  }
  const before = Array.isArray(entries) ? entries : []
  const floor = Math.ceil(before.length * Number(options.minKeepRatio ?? 2 / 3))
  if (before.length && lines.length < floor) {
    return { ok: false, error: `rethink 只留 ${lines.length} 条，少于原来的 2/3（${floor} 条）：整层重写不许砍掉一半事实` }
  }
  const size = usage(lines, limit)
  if (size.used > limit) {
    return { ok: false, error: `重新整理后仍超上限：${size.used}/${limit}，超出 ${size.used - limit}` }
  }
  return { ok: true, entries: lines, usage: size, rethought: true, from: before.length, to: lines.length }
}

/**
 * Apply a batch, then enforce the limit on the final result.
 *
 * `options.routeThreshold` is the soft ceiling that turns into a hard refusal:
 * a resident tier that is already 90% full should not accept more entries, or it
 * fills up and the review has to keep compressing (which loses detail). Rewrites
 * and merges still pass, because they are how a full tier gets smaller.
 */
export function applyOperations(entries, ops, limit, options = {}) {
  const threshold = Number(options.routeThreshold ?? DEFAULT_ROUTE_THRESHOLD)
  const addOverflow = String(options.addOverflow ?? 'topic')
  let current = [...entries]
  const merges = []
  const redirects = []
  /** Old text of every entry an `add` silently rewrote, so the caller can show it. */
  const replaced = []
  /** Old hash → the hash that replaced it: the invalidation chain written into meta. */
  const superseded = {}
  for (const op of Array.isArray(ops) ? ops : []) {
    if (op?.action === 'add' && threshold > 0) {
      const content = String(op?.content ?? '').trim()
      const mergeCandidate = content !== '' && current.some((entry) => similarity(entry, content) >= MERGE_SIMILARITY)
      if (content !== '' && !mergeCandidate) {
        const size = usage(current, limit)
        if (size.used >= limit * threshold) {
          if (addOverflow === 'reject') {
            return {
              ok: false,
              blocked: 'threshold',
              entries: current,
              usage: size,
              error: `常驻已用 ${size.percent}%（阈值 ${Math.round(threshold * 100)}%）：这次 add 被拒绝。请用 patch 合并已有条目，或把细节写进 topic。`,
            }
          }
          // Full tier, but a write should never fail just because of capacity:
          // hand the entry to the caller so it can land in the topic library.
          // The summary travels with it — dropping it left the index line with a
          // bare slug, and the head carries 70% of the recall score.
          redirects.push({
            content,
            summary: String(op?.summary ?? '').trim(),
            slugHint: String(op?.topic ?? '').trim(),
            keywords: op?.keywords,
          })
          continue
        }
      }
    }
    const result = applyOperation(current, op)
    if (!result.ok) return { ok: false, error: result.error, entries: current }
    if (result.mergedInto) {
      merges.push(result.mergedInto)
      superseded[result.mergedInto] = result.replacementHash ?? entryHash(String(op?.content ?? '').trim())
      if (result.replacedText) replaced.push({ hash: result.mergedInto, preview: String(result.replacedText).slice(0, 80) })
    }
    if (result.replacedInto) superseded[result.replacedInto] = result.replacementHash
    current = result.entries
  }
  const size = usage(current, limit)
  if (size.used > limit) {
    return {
      ok: false,
      error: `超出上限：${size.used}/${limit} 字符，超出 ${size.used - limit}。请在同一次调用里先合并或删除旧条目，再添加新内容。`,
      entries: current,
      usage: size,
      overflow: size.used - limit,
    }
  }
  return { ok: true, entries: current, usage: size, merges, redirects, replaced, superseded }
}

/**
 * Filter a tier down to what may be injected: active entries that are not past
 * their expiry date. Expired facts stay in the file (mem0's rule) so history can
 * still show them; they just stop costing prompt space.
 */
export function visibleEntries(entries, meta, today = new Date().toISOString().slice(0, 10)) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const record = meta?.entries?.[entryHash(entry)]
    if (!record) return true
    if (record.status && record.status !== 'active') return false
    if (record.expiresAt && String(record.expiresAt) < today) return false
    return true
  })
}
/** Render one prompt block for a target. */
export function renderBlock(title, entries, limit) {
  if (!entries.length) return ''
  const size = usage(entries, limit)
  const head = `## ${title} [${size.percent}% — ${size.used}/${size.limit} 字符]`
  return `${head}\n${entries.map((entry) => `- ${entry.replace(/\n/g, '\n  ')}`).join('\n')}`
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return ''
    throw error
  }
}

export async function readEntries(id, target, env = process.env) {
  return parseEntries(await readText(memoryFile(id, target, env)))
}

/**
 * Synchronous read, for the prompt section.
 *
 * The section text callback must return a string synchronously; an async load
 * started at agent creation loses the race against the first assembly, which is
 * exactly what an early version did — the first (and for subagents, only) step
 * saw an empty memory block. Reading here is cheap (a few KB) and happens once
 * per session, when the snapshot is frozen.
 */
export function readEntriesSync(id, target, env = process.env) {
  try {
    return parseEntries(readFileSync(memoryFile(id, target, env), 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
}

/** Per-entry metadata lives beside the text; it never costs a character of the budget. */
export function metaFile(id, env = process.env) {
  return path.join(personaDir(id, env), 'memory', 'meta.json')
}

export function readMetaSync(id, env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(metaFile(id, env), 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.entries ? parsed : { version: 1, entries: {} }
  } catch {
    return { version: 1, entries: {} }
  }
}

/**
 * Rebuild the metadata map from the current entries, keeping what we already
 * know about an entry and stamping the rest. Deleting or rewriting an entry
 * simply drops its record, so the map can never drift for long.
 */
export async function refreshMeta(id, stamp = {}, env = process.env) {
  const previous = readMetaSync(id, env)
  const at = stamp.at ?? new Date().toISOString()
  const next = { version: 2, updatedAt: new Date().toISOString(), entries: {} }
  const ttlDays = stamp.ttlDays ?? {}
  for (const target of TARGETS) {
    for (const text of await readEntries(id, target, env)) {
      const hash = entryHash(text)
      const before = previous.entries?.[hash]
      const days = Number(ttlDays[target] ?? 0)
      next.entries[hash] = before
        ? { ...before, preview: text.slice(0, 80), status: 'active', invalidAt: null, supersededBy: null, lastSeenAt: at }
        : {
            target,
            createdAt: at,
            validAt: at,
            invalidAt: null,
            supersededBy: null,
            expiresAt: days > 0 ? new Date(Date.parse(at) + days * 86400000).toISOString().slice(0, 10) : null,
            turn: Number.isFinite(stamp.turn) ? stamp.turn : null,
            preview: text.slice(0, 80),
            status: 'active',
          }
    }
  }
  // Entries that are gone from the file are not erased from history: a rewritten
  // fact keeps a link to its replacement, a deleted one keeps a removal stamp.
  for (const [hash, record] of Object.entries(previous.entries ?? {})) {
    if (next.entries[hash]) continue
    const heir = stamp.superseded?.[hash]
    next.entries[hash] = heir
      ? { ...record, status: 'superseded', invalidAt: at, supersededBy: heir }
      : { ...record, status: 'removed', invalidAt: at }
  }
  await fs.mkdir(path.dirname(metaFile(id, env)), { recursive: true })
  await fs.writeFile(metaFile(id, env), `${JSON.stringify(next, null, 2)}
`, 'utf8')
  return { count: Object.keys(next.entries).length }
}
/**
 * Serialise writes per persona.
 *
 * Two sessions of the same persona can finish a review at the same moment; both
 * would read the file, apply their own batch and write, and the second would
 * silently drop the first one's entry. Reads stay lock-free — only the
 * read-modify-write section needs the queue.
 */
const writeLocks = new Map()

export function withPersonaLock(id, task) {
  const key = String(id)
  const previous = writeLocks.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  writeLocks.set(key, run.then(() => {}, () => {}))
  return run
}
export async function writeEntries(id, target, entries, env = process.env) {
  const file = memoryFile(id, target, env)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await fs.writeFile(temp, formatEntries(target, entries), 'utf8')
  await fs.rename(temp, file)
  return file
}
