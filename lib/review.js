/**
 * dsh-persona — per-turn review (Host half).
 *
 * After a turn settles, one model call replays a digest of the conversation
 * together with the persona's current memory, and returns a structured list of
 * memory edits. Edits go through the same storage rules as the `memory` tool:
 * hard character limits, duplicate rejection, secret screening. Every applied
 * batch is recorded in an audit log so a bad automatic write can be traced and
 * undone.
 *
 * The review never blocks a reply and never rewrites the running prompt: the
 * frozen snapshot belongs to the session that opened before the write.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_LIMITS,
  applyOperations,
  personaDir,
  readEntries,
  refreshMeta,
  withPersonaLock,
  resolveDshHome,
  sanitizeId,
  usage,
  writeEntries,
} from './store.js'
import { limitsForPersona, readIndex, resolvePersonaForCwd } from './roster.js'
import { TOPIC_MAX_CHARS, autoSlug, writeTopic, writeTopicManifest } from './topics.js'
import { isTrivialPrompt, recallChars } from './recall.js'

export const name = 'persona-review'
export const inject = ['llm']

const MAX_DIGEST_CHARS = 6000
const MAX_OPS = 5

const SYSTEM_PROMPT = [
  '你是长期记忆整理器。读对话摘要与现有记忆，输出需要长期保留的改动。',
  '只输出 JSON，不要解释、不要 Markdown 代码块。',
  '格式：{"ops":[{"target":"user|memory|topic","action":"add|patch|remove","content":"...","old_text":"...","topic":"slug","summary":"一句话"}]}',
  '规则：',
  '- user 放对方是谁、偏好、沟通方式、忌讳；memory 放环境事实、项目约定、教训、已完成的事。',
  '- 操作步骤、排查过程、项目背景、长清单、一次性知识放 topic：此时才需要 topic（短 slug）与 summary（≤30 字），content 写正文。',
  '- target 为 user/memory 时不要输出 topic、summary 字段；每条 content 控制在 400 字符以内，超长就写进 topic。',
  '- add 不要带 old_text。',
  '- 只记值得跨会话保留的稳定信息。临时细节、能从代码或文件读到的、寒暄，一律不记。',
  '- 没有值得记的就输出 {"ops":[]}。',
  `- 最多 ${MAX_OPS} 条；每条一句话，能独立看懂。`,
  '- 修改或删除已有条目时用 patch/remove，old_text 必须能在现有条目里唯一定位。',
].join('\n')

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Rebuild a digest from the durable session log.
 *
 * Events carry their payload under `data` (`{type:'user/message', data:{content}}`),
 * which is the shape the session file uses; the live buffer path accepts both.
 */
/**
 * The audit log is append-only and would grow forever; past this size it is
 * renamed to `log.jsonl.1` (one previous generation kept) before the next write.
 */
export const LOG_ROTATE_BYTES = 256 * 1024

export function needsRotation(size) {
  return Number(size) >= LOG_ROTATE_BYTES
}

/** Escape control characters, drop trailing commas and close what the model left open. */
export function repairJson(text) {
  const source = String(text ?? '')
  let out = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index]
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue }
      if (ch === '\\') { out += ch; escaped = true; continue }
      if (ch === '"') { inString = false; out += ch; continue }
      if (ch === '\n') { out += '\\n'; continue }
      if (ch === '\r') { out += '\\r'; continue }
      if (ch === '\t') { out += '\\t'; continue }
      if (ch.charCodeAt(0) < 0x20) { out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`; continue }
      out += ch
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    out += ch
  }
  if (inString) out += '"'
  out = out.replace(/,(\s*[}\]])/g, '$1').replace(/,\s*$/, '')
  const stack = []
  let inStr = false
  let esc = false
  for (const ch of out) {
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  while (stack.length) out += stack.pop() === '{' ? '}' : ']'
  return out
}

/** Every balanced `{...}` in the text, including nested ones, so a torn tail can be dropped. */
export function extractOpObjects(text) {
  const source = String(text ?? '')
  const objects = []
  const stack = []
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') { stack.push(index); continue }
    if (ch === '}') {
      const start = stack.pop()
      if (start !== undefined) objects.push(source.slice(start, index + 1))
    }
  }
  const looksLikeOp = (value) => value.includes('"target"') && value.includes('"action"')
  const opsLike = objects.filter(looksLikeOp)
  const dropped = stack.length > 0 && looksLikeOp(source.slice(stack[stack.length - 1])) ? 1 : 0
  return { objects: opsLike, dropped }
}
/** Short, stable hash of one memory entry: the join key between an entry and its evidence. */
export function entryHash(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 12)
}

function sha12(text) {
  return entryHash(text)
}

async function sizeOf(file) {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

function messagesFromSession(session) {
  const events = Array.isArray(session?.events) ? session.events : []
  const out = []
  for (const event of events) {
    const type = String(event?.type ?? '')
    const isUser = type === 'user/message'
    const isAssistant = type === 'assistant/message'
    if (!isUser && !isAssistant) continue
    const text = textOfContent(event?.data?.content ?? event?.message?.content)
    if (!text.trim()) continue
    out.push({ role: isUser ? 'user' : 'assistant', text: clip(text, 1500) })
  }
  return out.slice(-12)
}

function clip(text, limit) {
  const value = String(text ?? '').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * ISO timestamp with the machine's UTC offset (e.g. 2026-11-05T19:30:00+08:00).
 * Still sortable and parseable, but it reads as local time when a human opens
 * the audit log — a bare `Z` value looked eight hours off in Beijing.
 */
function localIso(date = new Date()) {
  const pad = (value, width = 2) => String(Math.abs(value)).padStart(width, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  )
}

export function apply(ctx, config = {}) {
  const fallbackPersona = sanitizeId(config.personaId ?? 'default')
  const enabled = config.enabled !== false
  const dryRun = config.dryRun === true
  const everyTurns = Math.max(1, Number(config.everyTurns ?? 1))
  const maxTokens = Math.max(256, Number(config.maxTokens ?? 2000))
  const routeThreshold = Number(config.routeThreshold ?? 0.9)
  /** 常驻条目的有效期（天）；0 = 不过期。软期限与「被推翻」是两件事。 */
  const ttlDays = config.ttlDays ?? { memory: 180 }
  const limits = {
    user: Number(config.userLimit ?? DEFAULT_LIMITS.user),
    memory: Number(config.memoryLimit ?? DEFAULT_LIMITS.memory),
  }

  const buffers = new Map()
  const turns = new Map()
  const busy = new Set()
  const persistTimers = new Map()
  /** Closing sequence of the turn being reviewed, stamped onto every audit record. */
  let currentSeq
  /** Turn number reported by `agent/turn-stopping`; the client matches on this first. */
  let currentTurn

  /**
   * The digest lives in memory, but a plugin reload (or any restart) wipes it —
   * and the next turn would then be reviewed with no conversation at all, which
   * showed up as a silent `no-user-message` skip. Mirror the last 12 messages to
   * disk so a fresh instance can pick the turn back up.
   */
  const bufferFile = (sessionId) => path.join(resolveDshHome(), 'storages', 'persona-buffers', `${sanitizeId(sessionId, 'session')}.json`)

  const bufferOf = (sessionId) => {
    if (buffers.has(sessionId)) return buffers.get(sessionId)
    let restored = []
    try {
      const parsed = JSON.parse(readFileSync(bufferFile(sessionId), 'utf8'))
      if (Array.isArray(parsed)) restored = parsed.slice(-12)
    } catch {
      restored = []
    }
    buffers.set(sessionId, restored)
    return restored
  }

  const persistBuffer = (sessionId, buffer) => {
    const existing = persistTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    persistTimers.set(
      sessionId,
      setTimeout(() => {
        persistTimers.delete(sessionId)
        const file = bufferFile(sessionId)
        void mkdir(path.dirname(file), { recursive: true })
          .then(() => writeFile(file, JSON.stringify(buffer.slice(-12)), 'utf8'))
          .catch(() => {})
      }, 200),
    )
  }

  ctx.on('session/event', (session, event) => {
    if (!enabled) return
    const sessionId = session?.id
    if (!sessionId) return
    const type = String(event?.type ?? '')
    let role = ''
    if (/user/i.test(type)) role = 'user'
    else if (/assistant/i.test(type)) role = 'assistant'
    if (!role) return
    const payload = event?.data ?? event
    const text = textOfContent(payload?.content ?? payload?.message?.content ?? event?.message?.content ?? event?.text)
    if (!text.trim()) return
    const buffer = bufferOf(sessionId)
    buffer.push({ role, text: clip(text, 1500) })
    while (buffer.length > 12) buffer.shift()
    persistBuffer(sessionId, buffer)
  })

  const resolveModel = () => {
    if (config.provider && config.model) {
      return { provider: String(config.provider), model: String(config.model) }
    }
    try {
      const defaults = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
      const selection = defaults?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      /* fall through */
    }
    return undefined
  }

  /** Same rule as the memory plugin: the session's workspace picks the persona. */
  const resolvePersona = async (agent) => {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd) {
      try {
        const index = await readIndex(process.env)
        const persona = resolvePersonaForCwd(index, cwd)
        if (persona) return persona.id
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-persona] 读取角色清单失败：${String(error)}`)
      }
    }
    return fallbackPersona
  }

  const buildPrompt = async (buffer, persona, activeLimits) => {
    const [user, memory] = await Promise.all([readEntries(persona, 'user'), readEntries(persona, 'memory')])
    const conversation = buffer
      .map((entry) => `${entry.role === 'user' ? '用户' : '助手'}：${entry.text}`)
      .join('\n')
    const userUsage = usage(user, activeLimits.user)
    const memoryUsage = usage(memory, activeLimits.memory)
    const tight = []
    if (userUsage.percent >= 85) tight.push(`user 记忆已用 ${userUsage.percent}%`)
    if (memoryUsage.percent >= 85) tight.push(`memory 记忆已用 ${memoryUsage.percent}%`)
    return [
      `当前 user 记忆（${userUsage.used}/${activeLimits.user}）：`,
      user.length ? user.map((entry) => `- ${entry}`).join('\n') : '(空)',
      '',
      `当前 memory 记忆（${memoryUsage.used}/${activeLimits.memory}）：`,
      memory.length ? memory.map((entry) => `- ${entry}`).join('\n') : '(空)',
      '',
      ...(tight.length
        ? [
            `空间提醒：${tight.join('，')}。这一次请优先用 patch 合并、压缩已有条目，尽量不要再 add；`,
            '确实需要新增时，同一次调用里先删掉或合并旧条目；细节类内容（步骤、排查、项目背景）一律写 topic，不要 add 到 memory。',
            '注意：常驻层用量 ≥90% 时系统会直接拒绝 add，请改用 patch 合并或写 topic。',
            '',
          ]
        : []),
      '本次对话摘要：',
      clip(conversation, MAX_DIGEST_CHARS) || '(空)',
      '',
      '输出 JSON。',
    ].join('\n')
  }

  const collect = async (stream) => {
    let text = ''
    let finishReason = ''
    let usage = null
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'text' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage
      if (chunk.type === 'finish') {
        finishReason = String(chunk.finishReason ?? chunk.reason ?? chunk.stopReason ?? '')
        break
      }
    }
    return { text, finishReason, usage }
  }

  /**
   * Parse the model's op list in three passes, because a single truncated byte
   * used to throw the whole turn away:
   *   1. strict JSON
   *   2. repaired JSON (escaped control chars, no trailing commas, closed brackets)
   *   3. salvage: keep every complete `{...}` that parses on its own, drop the torn tail
   */
  const parseOps = (raw, options = {}) => {
    const cleaned = String(raw ?? '')
      .replace(/^\s*```(?:json)?/i, '')
      .replace(/```\s*$/, '')
      .trim()
    if (!cleaned) return { ops: [], salvaged: 0, dropped: 0 }

    const start = cleaned.indexOf('{')
    if (start < 0) return { ops: [], salvaged: 0, dropped: 0, failed: true, error: '输出里没有 JSON 对象' }
    const end = cleaned.lastIndexOf('}')
    const slice = cleaned.slice(start, end > start ? end + 1 : cleaned.length)

    const pick = (value) => (Array.isArray(value?.ops) ? value.ops : Array.isArray(value) ? value : []).slice(0, MAX_OPS)

    if (!options.truncated) {
      try {
        return { ops: pick(JSON.parse(slice)), salvaged: 0, dropped: 0 }
      } catch {
        /* fall through */
      }
    }

    const repaired = options.truncated ? '' : repairJson(slice)
    if (repaired) {
      try {
        return { ops: pick(JSON.parse(repaired)), salvaged: 0, dropped: 0, repaired: true }
      } catch {
        /* fall through */
      }
    }

    const { objects, dropped } = extractOpObjects(slice)
    const ops = []
    let torn = dropped
    for (const text of objects) {
      try {
        const one = JSON.parse(text)
        if (one && typeof one === 'object' && one.target && one.action) ops.push(one)
        else torn += 1
      } catch {
        torn += 1
      }
    }
    if (ops.length) return { ops: ops.slice(0, MAX_OPS), salvaged: ops.length, dropped: torn }
    return { ops: [], salvaged: 0, dropped: torn, failed: true, error: '输出不是合法 JSON，且没有可抢救的完整 op' }
  }

  /** Status vocabulary: what happened, not just "did the run throw". */
  const statusOf = (record) => {
    if (record.status) return record.status
    if (record.reason === 'no-model') return 'skipped'
    if (record.reason === 'parse-failed' || record.reason === 'error') return 'failed'
    if (record.note === 'no-user-message') return 'skipped'
  if (record.note === 'trivial-turn') return 'skipped'
    if (record.note === 'no-ops') return 'no-change'
    if (record.dryRun) return 'dry-run'
    const applied = Array.isArray(record.applied) ? record.applied.length : 0
    const rejected = Array.isArray(record.rejected) ? record.rejected.length : 0
    if (applied && rejected) return 'partial'
    if (applied) return 'written'
    if (rejected) return 'rejected'
    return 'ok'
  }

  const audit = async (record, persona) => {
    const dir = path.join(personaDir(persona), 'review')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'log.jsonl')
    if (needsRotation(await sizeOf(file))) await rename(file, `${file}.1`).catch(() => {})
    const entry = { ...record, status: statusOf(record) }
    if (typeof currentTurn === 'number') entry.turn = currentTurn
    if (typeof currentSeq === 'number') entry.seq = currentSeq
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  /**
   * A turn is reviewed at most once. Hook replays and plugin reloads can re-emit
   * `turn-stopping` for the same turn; without this the same facts would be
   * written twice.
   */
  const turnAlreadyApplied = async (sessionId, turn, persona) => {
    if (!Number.isFinite(turn)) return false
    let text = ''
    try {
      text = await readFile(path.join(personaDir(persona), 'review', 'log.jsonl'), 'utf8')
    } catch {
      return false
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record.sessionId !== sessionId || record.turn !== turn) continue
      if (Array.isArray(record.applied) && record.applied.length) return true
    }
    return false
  }

  /**
   * Evidence journal: every write records which turn produced which entry hash,
   * so a line in `memory.md` can always be traced back to the conversation that
   * put it there (the "derived data must point at its source" rule).
   */
  const appendEvidence = async (persona, entry) => {
    const dir = path.join(personaDir(persona), 'review')
    await mkdir(dir, { recursive: true })
    await appendFile(path.join(dir, 'evidence.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
  }

  /** Every review writes one metric line, including failures — silence is the bug we just fixed. */
  const writeMetric = async (persona, entry) => {
    try {
      const dir = path.join(personaDir(persona), 'review')
      await mkdir(dir, { recursive: true })
      await appendFile(path.join(dir, 'metrics.jsonl'), `${JSON.stringify(entry)}
`, 'utf8')
    } catch {
      /* metrics must never break a review */
    }
  }
  const runReview = async (agent, signal, turn) => {
    const startedAt = Date.now()
    const sessionId = agent?.id
    if (!sessionId || busy.has(sessionId)) return
    const persona = await resolvePersona(agent)
    // Turn number is the reliable key for the client; seq is a best-effort fallback.
    currentTurn = Number.isFinite(turn) ? turn : undefined
    const events = Array.isArray(agent?.session?.events) ? agent.session.events : []
    currentSeq = events.length ? Number(events[events.length - 1]?.seq ?? NaN) : undefined
    if (!Number.isFinite(currentSeq)) currentSeq = undefined

    if (await turnAlreadyApplied(sessionId, currentTurn, persona)) {
      await audit(
        { at: localIso(), ms: 0, sessionId, persona, ok: true, note: 'duplicate-turn', status: 'skipped' },
        persona,
      ).catch(() => {})
      return
    }

    // The live buffer covers the common case; a reloaded plugin starts empty, so
    // fall back to the durable session log instead of reporting "nothing to see".
    const buffered = bufferOf(sessionId)
    const messages = buffered.some((entry) => entry.role === 'user')
      ? buffered
      : messagesFromSession(agent?.session)

    // Bare acknowledgements are not worth a model call (Hermes' is_trivial_prompt).
  const lastUserForGate = [...messages].reverse().find((entry) => entry.role === 'user')
  if (lastUserForGate && isTrivialPrompt(lastUserForGate.text)) {
    await audit({ at: localIso(), ms: Date.now() - startedAt, sessionId, persona, ok: true, note: 'trivial-turn' }, persona).catch(() => {})
    await writeMetric(persona, {
      at: localIso(),
      turn: currentTurn ?? null,
      sessionId,
      status: 'skipped',
      reason: 'trivial',
      recallChars: recallChars(),
      ms: Date.now() - startedAt,
    })
    return
  }

  if (!messages.some((entry) => entry.role === 'user')) {
      await audit({ at: localIso(), ms: Date.now() - startedAt, sessionId, persona, ok: true, note: 'no-user-message' }, persona).catch(
        () => {},
      )
      return
    }

    const model = resolveModel()
    if (!model) {
      await audit(
        {
          at: localIso(), ms: Date.now() - startedAt,
          sessionId,
          persona,
          ok: false,
          reason: 'no-model',
          note: '未配置复盘模型，也没有默认模型',
        },
        persona,
      ).catch(() => {})
      return
    }

    busy.add(sessionId)
    try {
      let activeLimits = limits
      try {
        activeLimits = limitsForPersona(await readIndex(process.env), persona, limits)
      } catch {
        /* keep configured defaults */
      }
      const prompt = await buildPrompt(messages, persona, activeLimits)
      const attempt = async (tokens, hint) =>
        collect(
          ctx.llm.stream({
            provider: model.provider,
            model: model.model,
            maxTokens: tokens,
            messages: [
              { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
              { role: 'user', content: [{ type: 'text', text: hint ? `${prompt}\n\n${hint}` : prompt }] },
            ],
            signal,
          }),
        )

      let { text: raw, finishReason, usage } = await attempt(maxTokens, '')
      const zeroTokens = { in: 0, out: 0, cacheRead: 0 }
      const tokenStat = (value) =>
        value
          ? {
              in: Number(value.input_tokens ?? value.prompt_tokens ?? 0),
              out: Number(value.output_tokens ?? value.completion_tokens ?? 0),
              cacheRead: Number(value.cache_read_input_tokens ?? 0),
            }
          : zeroTokens
      const truncated = (value) => /length|max_tokens|max tokens|truncat/i.test(String(value ?? '')) || (value === '' && raw.trim().endsWith('{'))
      const truncated0 = truncated(finishReason)
      let parsed = parseOps(raw, { truncated: truncated0 })
      let retried = false
      if (!parsed.ops.length && truncated0) {
        // Output was cut off mid-JSON: one retry with twice the budget and a
        // terser instruction, because that is cheaper than losing the turn.
        retried = true
        const second = await attempt(maxTokens * 2, '注意：上一次输出被长度截断。这次只输出 JSON 的 ops 列表，不要任何解释；每条 content 不超过 300 字符。')
        raw = second.text
        finishReason = second.finishReason
        usage = second.usage
        parsed = parseOps(raw, { truncated: truncated(second.finishReason) })
      }

      const ops = parsed.ops
      if (!ops.length) {
        const failed = parsed.failed
        await audit(
          failed
            ? {
                at: localIso(), ms: Date.now() - startedAt,
                sessionId,
                persona,
                model,
                ok: false,
                reason: 'parse-failed',
                detail: parsed.error,
                finishReason: finishReason || null,
                truncated: truncated(finishReason),
                retried,
                raw: clip(raw, 800),
              }
            : { at: localIso(), ms: Date.now() - startedAt, sessionId, persona, model, ok: true, applied: [], note: 'no-ops' },
          persona,
        )
        await writeMetric(persona, {
          at: localIso(), turn: currentTurn ?? null, sessionId,
          status: failed ? 'failed' : 'no-change',
          reason: failed ? 'parse-failed' : 'no-ops',
          recallChars: recallChars(),
        tokens: tokenStat(usage),
        salvaged: parsed.salvaged ?? 0,
          truncated: truncated(finishReason),
          retried,
          ms: Date.now() - startedAt,
        })
        return
      }
      if (parsed.salvaged) {
        ctx.logger?.warn?.(`[dsh-persona] 复盘输出被修复：救回 ${parsed.salvaged} 条，丢弃 ${parsed.dropped} 条`)
      }
      if (dryRun) {
        await audit(
          { at: localIso(), ms: Date.now() - startedAt, sessionId, persona, model, ok: true, dryRun: true, ops },
          persona,
        )
        buffered.length = 0
        return
      }

      const applied = []
      const rejected = []
      const supersededAll = {}
      for (const target of ['user', 'memory']) {
        const targetOps = ops.filter((op) => (op?.target ?? 'memory') === target)
        if (!targetOps.length) continue
        // Read-modify-write under a per-persona lock: two sessions finishing at
        // the same moment must not overwrite each other's batch.
        const result = await withPersonaLock(persona, async () => {
          const current = await readEntries(persona, target)
          const applied = applyOperations(current, targetOps, activeLimits[target], { routeThreshold })
          if (applied.ok) await writeEntries(persona, target, applied.entries)
          return applied
        })
        if (!result.ok) {
          rejected.push({ target, error: result.error, ...(result.blocked ? { reason: result.blocked } : {}) })
          continue
        }
        applied.push({ target, count: targetOps.length, usage: result.usage, merges: result.merges ?? [] })
        Object.assign(supersededAll, result.superseded ?? {})

        // Additions that did not fit the resident tier are written to the topic
        // library instead of being rejected — capacity must not lose a fact.
        for (const item of result.redirects ?? []) {
          const hint = targetOps.find((op) => op?.action === 'add' && String(op?.content ?? '').trim() === item.content)
          const slug = String(hint?.topic ?? '').trim() || autoSlug(item.content)
          const written = await writeTopic(persona, { slug, summary: hint?.summary, content: item.content })
          if (!written.ok) {
            rejected.push({ target: 'topic', error: written.error, redirected: true })
            continue
          }
          applied.push({ target: 'topic', topic: written.slug, count: 1, redirected: true })
          await writeTopicManifest(persona).catch(() => {})
        }
      }

      // Topic ops are detail: they never touch the resident limits, and they
      // land in the topic library that the prompt only indexes.
      for (const op of ops.filter((item) => item?.target === 'topic')) {
        const content = String(op?.content ?? '').trim()
        if (!content) {
          rejected.push({ target: 'topic', error: '内容为空' })
          continue
        }
        const written = await writeTopic(persona, {
          slug: op?.topic ?? op?.slug ?? content.slice(0, 12),
          summary: op?.summary,
          content,
        })
        if (!written.ok) {
          rejected.push({ target: 'topic', error: written.error })
          continue
        }
        applied.push({ target: 'topic', topic: written.slug, count: 1, usage: { used: written.chars, limit: TOPIC_MAX_CHARS } })
        await writeTopicManifest(persona).catch(() => {})
      }

      await audit(
        { at: localIso(), ms: Date.now() - startedAt, sessionId, persona, model, ok: true, applied, rejected, ops },
        persona,
      )
      buffered.length = 0
      if (applied.length) {
        await refreshMeta(persona, { at: localIso(), turn: currentTurn, ttlDays, superseded: supersededAll }).catch(() => {})
      }
      // Every outcome gets a metric line — a run that was entirely rejected is
      // exactly the kind of silence that hid five days of failures before.
      await writeMetric(persona, {
        at: localIso(),
        turn: currentTurn ?? null,
        sessionId,
        resident: applied.filter((item) => item.target !== 'topic').map((item) => ({ target: item.target, used: item.usage?.used ?? 0 })),
        topics: applied.filter((item) => item.target === 'topic').map((item) => item.topic ?? ''),
        merges: applied.flatMap((item) => item.merges ?? []),
        blocked: rejected.filter((item) => item.reason === 'threshold').length,
        redirected: applied.filter((item) => item.redirected).length,
        status: rejected.length && !applied.length ? 'rejected' : rejected.length ? 'partial' : 'written',
        recallChars: recallChars(),
        tokens: tokenStat(usage),
        salvaged: parsed.salvaged ?? 0,
        truncated: truncated(finishReason),
        retried,
        ms: Date.now() - startedAt,
      })
      if (applied.length && Number.isFinite(currentTurn)) {
        await appendEvidence(persona, {
          at: localIso(),
          turn: currentTurn,
          sessionId,
          events: ops.map((op) => ({
            target: op?.target ?? 'memory',
            action: op?.action,
            hash: entryHash(op?.content ?? op?.old_text ?? ''),
            chars: String(op?.content ?? '').length,
          })),
        }).catch(() => {})
      }
      if (applied.length) {
        const summary = applied.map((entry) => `${entry.target}×${entry.count}`).join('，')
        ctx.logger?.info?.(`[dsh-persona] 记忆已更新（${summary}）`)
      }
    } catch (error) {
      await audit(
        {
          at: localIso(), ms: Date.now() - startedAt,
          sessionId,
          model,
          ok: false,
          reason: 'error',
          detail: error instanceof Error ? error.message : String(error),
        },
        fallbackPersona,
      ).catch(() => {})
    } finally {
      busy.delete(sessionId)
    }
  }

  if (!enabled) return { personaId: fallbackPersona, disabled: true }

  ctx.on('agent/turn-stopping', async (payload) => {
    const agent = payload?.agent
    const sessionId = agent?.id
    if (!sessionId) return
    const count = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, count)
    if (count % everyTurns !== 0) return
    // Fire and forget: the reply must not wait for the review.
    void runReview(agent, payload?.signal, payload?.turn)
  })

  return { personaId: fallbackPersona, reviewPath: path.join(personaDir(fallbackPersona), 'review') }
}
