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
export function applyOperation(entries, op) {
  const action = String(op?.action ?? '')
  const content = String(op?.content ?? '')

  if (action === 'add') {
    const check = inspectContent(content)
    if (!check.ok) return { ok: false, error: check.error }
    const normalized = content.trim()
    if (entries.some((entry) => entry.trim() === normalized)) {
      return { ok: false, error: '已有完全相同的条目，未重复添加' }
    }
    return { ok: true, entries: [...entries, normalized] }
  }

  if (action === 'patch') {
    const check = inspectContent(content)
    if (!check.ok) return { ok: false, error: check.error }
    const hits = findMatches(entries, op?.old_text)
    if (hits.length === 0) return { ok: false, error: '没有条目包含 old_text，无法修改' }
    if (hits.length > 1) return { ok: false, error: `old_text 命中 ${hits.length} 处，请提供更长的唯一片段` }
    const { index, at } = hits[0]
    const next = [...entries]
    next[index] = entries[index].slice(0, at) + content + entries[index].slice(at + String(op.old_text).length)
    return { ok: true, entries: next }
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

/** Apply a batch, then enforce the limit on the final result. */
export function applyOperations(entries, ops, limit) {
  let current = [...entries]
  for (const op of Array.isArray(ops) ? ops : []) {
    const result = applyOperation(current, op)
    if (!result.ok) return { ok: false, error: result.error, entries: current }
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
  return { ok: true, entries: current, usage: size }
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

export async function writeEntries(id, target, entries, env = process.env) {
  const file = memoryFile(id, target, env)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await fs.writeFile(temp, formatEntries(target, entries), 'utf8')
  await fs.rename(temp, file)
  return file
}
