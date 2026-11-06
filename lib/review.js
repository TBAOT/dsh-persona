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
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_LIMITS,
  applyOperations,
  personaDir,
  readEntries,
  sanitizeId,
  usage,
  writeEntries,
} from './store.js'
import { limitsForPersona, readIndex, resolvePersonaForCwd } from './roster.js'

export const name = 'persona-review'
export const inject = ['llm']

const MAX_DIGEST_CHARS = 6000
const MAX_OPS = 5

const SYSTEM_PROMPT = [
  '你是长期记忆整理器。读对话摘要与现有记忆，输出需要长期保留的改动。',
  '只输出 JSON，不要解释、不要 Markdown 代码块。',
  '格式：{"ops":[{"target":"user|memory","action":"add|patch|remove","content":"...","old_text":"..."}]}',
  '规则：',
  '- user 放对方是谁、偏好、沟通方式、忌讳；memory 放环境事实、项目约定、教训、已完成的事。',
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
  const maxTokens = Math.max(128, Number(config.maxTokens ?? 1200))
  const limits = {
    user: Number(config.userLimit ?? DEFAULT_LIMITS.user),
    memory: Number(config.memoryLimit ?? DEFAULT_LIMITS.memory),
  }

  const buffers = new Map()
  const turns = new Map()
  const busy = new Set()

  const bufferOf = (sessionId) => {
    if (!buffers.has(sessionId)) buffers.set(sessionId, [])
    return buffers.get(sessionId)
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
    return [
      `当前 user 记忆（${usage(user, activeLimits.user).used}/${activeLimits.user}）：`,
      user.length ? user.map((entry) => `- ${entry}`).join('\n') : '(空)',
      '',
      `当前 memory 记忆（${usage(memory, activeLimits.memory).used}/${activeLimits.memory}）：`,
      memory.length ? memory.map((entry) => `- ${entry}`).join('\n') : '(空)',
      '',
      '本次对话摘要：',
      clip(conversation, MAX_DIGEST_CHARS) || '(空)',
      '',
      '输出 JSON。',
    ].join('\n')
  }

  const collect = async (stream) => {
    let text = ''
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'text' && typeof chunk.text === 'string') text += chunk.text
      if (chunk.type === 'finish') break
    }
    return text
  }

  const parseOps = (raw) => {
    const cleaned = String(raw ?? '')
      .replace(/^\s*```(?:json)?/i, '')
      .replace(/```\s*$/, '')
      .trim()
    if (!cleaned) return []
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) return []
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    const list = Array.isArray(parsed?.ops) ? parsed.ops : Array.isArray(parsed) ? parsed : []
    return list.slice(0, MAX_OPS)
  }

  /** Status vocabulary: what happened, not just "did the run throw". */
  const statusOf = (record) => {
    if (record.status) return record.status
    if (record.reason === 'no-model') return 'skipped'
    if (record.reason === 'parse-failed' || record.reason === 'error') return 'failed'
    if (record.note === 'no-user-message') return 'skipped'
    if (record.note === 'no-ops') return 'no-change'
    if (record.dryRun) return 'dry-run'
    if (Array.isArray(record.applied) && record.applied.length) return 'written'
    return 'ok'
  }

  const audit = async (record, persona) => {
    const dir = path.join(personaDir(persona), 'review')
    await mkdir(dir, { recursive: true })
    const entry = { ...record, status: statusOf(record) }
    await appendFile(path.join(dir, 'log.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
  }

  const runReview = async (agent, signal) => {
    const startedAt = Date.now()
    const sessionId = agent?.id
    if (!sessionId || busy.has(sessionId)) return
    const persona = await resolvePersona(agent)

    // The live buffer covers the common case; a reloaded plugin starts empty, so
    // fall back to the durable session log instead of reporting "nothing to see".
    const buffered = bufferOf(sessionId)
    const messages = buffered.some((entry) => entry.role === 'user')
      ? buffered
      : messagesFromSession(agent?.session)

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
      const raw = await collect(
        ctx.llm.stream({
          provider: model.provider,
          model: model.model,
          maxTokens,
          messages: [
            { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
            { role: 'user', content: [{ type: 'text', text: prompt }] },
          ],
          signal,
        }),
      )

      let ops = []
      try {
        ops = parseOps(raw)
      } catch (error) {
        await audit(
          {
            at: localIso(), ms: Date.now() - startedAt,
            sessionId,
            persona,
            model,
            ok: false,
            reason: 'parse-failed',
            detail: error instanceof Error ? error.message : String(error),
            raw: clip(raw, 800),
          },
          persona,
        )
        return
      }
      if (!ops.length) {
        await audit(
          { at: localIso(), ms: Date.now() - startedAt, sessionId, persona, model, ok: true, applied: [], note: 'no-ops' },
          persona,
        )
        return
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
      for (const target of ['user', 'memory']) {
        const targetOps = ops.filter((op) => (op?.target ?? 'memory') === target)
        if (!targetOps.length) continue
        const current = await readEntries(persona, target)
        const result = applyOperations(current, targetOps, activeLimits[target])
        if (!result.ok) {
          rejected.push({ target, error: result.error })
          continue
        }
        await writeEntries(persona, target, result.entries)
        applied.push({ target, count: targetOps.length, usage: result.usage })
      }

      await audit(
        { at: localIso(), ms: Date.now() - startedAt, sessionId, persona, model, ok: true, applied, rejected, ops },
        persona,
      )
      buffered.length = 0
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
    void runReview(agent, payload?.signal)
  })

  return { personaId: fallbackPersona, reviewPath: path.join(personaDir(fallbackPersona), 'review') }
}
