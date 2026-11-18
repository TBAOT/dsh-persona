/**
 * dsh-persona — persona memory plugin (Host half).
 *
 * Two tiers per persona, exactly like the Hermes memory model:
 *   - `user`   — the user profile: who they are, how they want to be answered
 *   - `memory` — the persona's own notes: environment facts, conventions, lessons
 *
 * Both live as plain Markdown under `<DSH_HOME>/personas/<id>/memory/`, are
 * injected once at session start and then stay frozen for the whole session
 * (so the prompt prefix — and therefore the provider cache — stays valid), and
 * are written only through the `memory` tool with `add` / `patch` / `remove`.
 * Limits are hard: an over-budget write is refused and reported, never silently
 * truncated, so the persona has to consolidate instead of losing entries.
 */
import {
  DEFAULT_LIMITS,
  TARGETS,
  applyOperations,
  memoryFile,
  entryHash,
  readEntries,
  readEntriesSync,
  readMetaSync,
  refreshMeta,
  visibleEntries,
  renderBlock,
  sanitizeId,
  similarity,
  usage,
  writeEntries,
} from './store.js'
import { limitsForPersona, readIndexSync, resolvePersonaForCwd } from './roster.js'
import { assertWritable, effectiveLimits, readPolicySync } from './policy.js'
import { TOPIC_MAX_CHARS, isTopicExpired, listTopicsSync, renderTopicIndex, writeTopic } from './topics.js'
import { noteRecall, selectTopics, stripStaleRecall, injectRecall } from './recall.js'
import { persistCompat, probeHost } from './compat.js'

export const name = 'persona-memory'
export const inject = ['tools', 'systemPrompt']

const TOOL_DESCRIPTION = [
  '维护当前角色的长期记忆，分三档（user / memory 为常驻，topic 为按需读取的细节）：',
  '• target=user —— 用户画像：对方是谁、偏好、沟通方式、忌讳。',
  '• target=memory —— 角色自己的笔记：环境事实、项目约定、踩过的坑、做完的事。',
  '• target=topic —— 细节：操作步骤、排查过程、项目背景。要带 topic（短 slug）与 summary（≤30 字）；同一主题复用同一 slug。',
  '',
  '操作只有三种：',
  '• add —— 追加一条（与已有条目完全重复会被拒绝）。常驻条目是"一条一个事实、不超过 120 字的一句话"：只写结论或判据（含"什么情况适用"），过程、命令、对照数据一律写 target=topic。',
  '• patch —— 用 old_text 定位唯一片段并替换；old_text 必须在该条内只出现一次。',
  '• remove —— 用 old_text 定位并删除整条；片段必须唯一。',
  '',
  '一次调用可以带多条 operations，最终结果必须在字符上限内，否则整批被拒绝并告知还差多少字符。',
  '记忆在会话开始时冻结注入；本会话内写入的内容，下一个会话才出现在提示词里，但工具返回始终显示实时用量。',
  '该记就记：对方纠正你、给出稳定偏好、确认约定、发现环境事实时，不用等他开口。',
].join('\n')

function normalizeOperations(args) {
  const list = Array.isArray(args?.operations) ? args.operations : []
  if (list.length) return list
  if (args?.action) {
    return [{ action: args.action, content: args.content, old_text: args.old_text }]
  }
  return []
}

/**
 * Never let this plugin's initialisation take the application down.
 *
 * A Host that renamed a seam can make `apply()` throw while the row is activating;
 * an exception there is the difference between "memory is missing" and "DSH won't
 * start". So the whole body is guarded: any failure logs once and leaves nothing
 * registered.
 */
export function apply(ctx, config = {}) {
  try {
    return applyInner(ctx, config)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    ctx?.logger?.warn?.(`[dsh-persona] memory 插件初始化失败，已停用（不影响 DSH 启动）：${detail}`)
    return { personaId: sanitizeId(config?.personaId ?? 'default'), disabled: true, error: detail }
  }
}

function applyInner(ctx, config = {}) {
  const personaId = sanitizeId(config.personaId ?? 'default')
  const limits = {
    user: Number(config.userLimit ?? DEFAULT_LIMITS.user),
    memory: Number(config.memoryLimit ?? DEFAULT_LIMITS.memory),
  }
  const titles = {
    user: String(config.userTitle ?? '用户画像 / USER PROFILE'),
    memory: String(config.memoryTitle ?? '长期记忆 / MEMORY'),
  }
  const inject = config.inject !== false
  /** Topic index: a pointer list, not the content. Disable to fall back to pure resident memory. */
  const topicsEnabled = config.topics !== false
  /** Past this share of a resident tier's budget, new entries are refused. 0 disables. */
  const routeThreshold = Number(config.routeThreshold ?? 0.9)
  const topicsLimit = Number(config.topicsIndexLimit ?? 600)
  /** Topics untouched for this many days stop being indexed; 0 keeps them forever. */
  const topicTtlDays = Number(config.topicTtlDays ?? 90)
  /** Per-turn recall: how many topic summaries to surface, and the char budget. 0 disables. */
  const recallTopN = Number(config.recallTopN ?? 3)
  const recallBudget = Number(config.recallBudget ?? 400)

  /** Frozen snapshot per session, read synchronously the first time it is needed. */
  const snapshots = new Map()

  // Probe the Host seams once. A missing required feature is fatal for the plugin's
  // purpose (no tools / no events); a missing optional one is degraded, not fatal.
  const host = probeHost(ctx)
  if (host.missing.length) ctx.logger?.warn?.(`[dsh-persona] 宿主缺少必需接口：${host.missing.join('、')}，插件无法正常工作`)
  if (host.degraded.length) ctx.logger?.warn?.(`[dsh-persona] 宿主缺少可选接口：${host.degraded.join('、')}，已降级运行`)
  // Leave the probe on disk for `pnpm health` (a different process) to read.
  persistCompat(host)
  /** Recall goes into runtime context when available, otherwise into the user message. */
  const recallViaContext = host.features.runtimeContext

  /**
   * Which persona serves this agent?
   *
   * The roster maps workspaces to personas, and a session's working directory
   * is the only stable signal we get for free. So a session opened inside a
   * bound workspace uses that persona; anything else falls back to the row's
   * configured `personaId`.
   */
  const resolvePersonaSync = (agent) => {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd) {
      const persona = resolvePersonaForCwd(readIndexSync(process.env), cwd)
      if (persona) return persona.id
    }
    return personaId
  }

  const resolvePersona = async (agent) => resolvePersonaSync(agent)

  /**
   * Build the snapshot on first use, synchronously.
   *
   * Doing this asynchronously at agent creation loses the race with the first
   * prompt assembly — and a subagent gets exactly one assembly, so it would
   * always see an empty memory block. Reading a few KB here is cheap and keeps
   * the frozen-snapshot semantics: later writes do not change this session.
   */
  const snapshotOf = (agent) => {
    if (!agent?.id) return undefined
    const cached = snapshots.get(agent.id)
    if (cached) return cached
    const persona = resolvePersonaSync(agent)
    const index = readIndexSync(process.env)
    const snapshot = {
      persona,
      user: visibleEntries(readEntriesSync(persona, 'user'), readMetaSync(persona)),
      memory: visibleEntries(readEntriesSync(persona, 'memory'), readMetaSync(persona)),
      limits: limitsForPersona(index, persona, limits),
      topics: topicsEnabled
        ? renderTopicIndex(listTopicsSync(persona).filter((topic) => !isTopicExpired(topic, topicTtlDays)), topicsLimit)
        : '',
    }
    snapshots.set(agent.id, snapshot)
    return snapshot
  }

  /** The text of the last user message, whatever shape the payload uses. */
  function lastUserText(container) {
    const lists = [container?.messages, container?.input?.messages, container?.request?.messages].filter(Array.isArray)
    for (const messages of lists) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (!message || message.role !== 'user') continue
        if (typeof message.content === 'string') return message.content
        if (Array.isArray(message.content)) {
          return message.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
        }
      }
    }
    return ''
  }

  /** Turn numbers whose recall block already went in, per agent. */
  const recalledTurns = new Map()
  /** The block for this turn, rendered as runtime context instead of into the user's message. */
  const pendingRecall = new Map()
  let recallWarned = false

  /**
   * Recall runs per turn: the resident tiers are frozen, but the turn can still carry
   * a few topic pointers chosen from what the user just asked.
   *
   * The block goes into **runtime context**, not into the user's message: whatever a
   * pre-step returns gets persisted, so appending there showed up in the user's own
   * bubble every turn. `ctx.systemPrompt.context` is evaluated per assembly and the
   * platform keeps it out of the conversation, which is what we want.
   */
  ctx.effect(() => {
    if (!recallViaContext) return () => {}
    return ctx.systemPrompt.context({
      name: 'persona:recall',
      order: 0.95,
      text: (context) => {
        const agentId = context?.agent?.id
        if (!agentId) return ''
        return pendingRecall.get(agentId)?.block ?? ''
      },
    })
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = typeof next === 'function' ? await next() : payload
    if (recallTopN <= 0) return decision
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    const startedAt = Date.now()
    const agent = payload?.agent
    const turn = Number.isFinite(payload?.turn) ? payload.turn : null
    try {
      const persona = agent ? resolvePersonaSync(agent) : personaId
      const topics = listTopicsSync(persona).filter((topic) => !isTopicExpired(topic, topicTtlDays))
      // Older versions appended the block to the message; strip those leftovers so the
      // history reads like what the user actually said.
      const messages = stripStaleRecall(decision.messages)
      const cleaned = { ...decision, messages }
      const query = lastUserText(cleaned) || lastUserText(payload)
      const seen = agent?.id ? recalledTurns.get(agent.id) : undefined
      // A turn runs several steps; the block belongs to the first one only.
      if (turn !== null && seen?.turn === turn) {
        noteRecall({ outcome: 'skipped', chars: 0, topics: [], ms: Date.now() - startedAt, turn })
        return cleaned
      }
      if (!topics.length) {
        if (agent?.id) pendingRecall.delete(agent.id)
        noteRecall({ outcome: 'no-topics', chars: 0, topics: [], ms: Date.now() - startedAt, turn })
        return cleaned
      }
      const picked = selectTopics(query, topics, { topN: recallTopN, budget: recallBudget })
      if (picked.reason !== 'matched') {
        if (agent?.id) pendingRecall.delete(agent.id)
        noteRecall({ outcome: picked.reason, chars: 0, topics: [], ms: Date.now() - startedAt, turn })
        return cleaned
      }
      // Preferred path: hand the block to runtime context, never to the message.
      if (recallViaContext) {
        if (agent?.id) {
          pendingRecall.set(agent.id, { turn, block: picked.block })
          recalledTurns.set(agent.id, { turn })
        }
        recallWarned = false
        noteRecall({ outcome: 'injected', chars: picked.block.length, topics: picked.picks, ms: Date.now() - startedAt, turn, error: null })
        return cleaned
      }
      // Degraded path: this Host has no runtime context, so append to the last user
      // message as older versions did. Dirtier (it shows up in the transcript), but the
      // alternative is no recall at all.
      const injected = injectRecall(cleaned.messages, picked.block)
      if (!injected.injected) {
        noteRecall({
          outcome: injected.reason === 'already-present' ? 'skipped' : 'unmatched-shape',
          chars: 0,
          topics: [],
          ms: Date.now() - startedAt,
          turn,
        })
        return cleaned
      }
      if (agent?.id) recalledTurns.set(agent.id, { turn })
      recallWarned = false
      noteRecall({ outcome: 'injected', chars: injected.chars, topics: picked.picks, ms: Date.now() - startedAt, turn, error: null, degraded: true })
      return { ...cleaned, messages: injected.messages }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      noteRecall({ outcome: 'error', chars: 0, topics: [], ms: Date.now() - startedAt, turn, error: detail })
      if (!recallWarned) {
        recallWarned = true
        ctx.logger?.warn?.(`[dsh-persona] 本轮召回注入失败，已跳过（同一会话只报一次）：${detail}`)
      }
      return decision
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id) {
      snapshots.delete(agent.id)
      recalledTurns.delete(agent.id)
      pendingRecall.delete(agent.id)
    }
  })

  if (inject) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'persona:user',
        order: 0.61,
        text: (assembly) => {
          const snapshot = snapshotOf(assembly?.agent)
          return snapshot ? renderBlock(titles.user, snapshot.user, snapshot.limits.user) : ''
        },
      }),
    )
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'persona:memory',
        order: 0.62,
        text: (assembly) => {
          const snapshot = snapshotOf(assembly?.agent)
          return snapshot ? renderBlock(titles.memory, snapshot.memory, snapshot.limits.memory) : ''
        },
      }),
    )
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'persona:topics',
        order: 0.63,
        text: (assembly) => {
          const snapshot = snapshotOf(assembly?.agent)
          if (!snapshot?.topics) return ''
          return `## 主题库 / TOPICS\n细节存在主题文件里，需要时按路径读取全文。\n${snapshot.topics}`
        },
      }),
    )
  }

  /**
   * Only active, unexpired entries are injected — the filter itself lives in
   * store.js (`visibleEntries`) so it can be tested without a live agent.
   */
  ctx.effect(() =>
    ctx.tools.register({
      name: 'memory',
      description: TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: [...TARGETS, 'topic'],
            description: 'user = 用户画像；memory = 角色自己的笔记；topic = 细节主题（配合 topic/summary）。',
          },
          topic: { type: 'string', description: 'target=topic 时的短 slug，例如 printer-fix 或 打印机。' },
          summary: { type: 'string', description: 'target=topic 时的一句话摘要（不超过 30 字）。' },
          keywords: {
            type: 'string',
            description: 'target=topic 时的检索别名（逗号分隔，如「权限备份,能不能删」）：用户会用别的词问，别名只参与打分、不占索引字符。',
          },
          operations: {
            type: 'array',
            description: '按顺序执行的一组操作。',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['add', 'patch', 'remove'], description: '操作类型。' },
                content: { type: 'string', description: 'add/patch 的新内容，纯文本或 Markdown。' },
                old_text: { type: 'string', description: 'patch/remove 用来定位的唯一片段。' },
              },
              required: ['action'],
            },
          },
        },
        required: ['target'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render(_args, value) {
          const text = value && typeof value.text === 'string' ? value.text : ''
          return [{ type: 'text', text }]
        },
      },
      async execute(args, exec) {
        const target = String(args?.target ?? '')
        const agent = exec?.agent
        if (target === 'topic') {
          const personaForTopic = (agent?.id ? snapshots.get(agent.id)?.persona : undefined) ?? (await resolvePersona(agent))
          const content = String(args?.content ?? '').trim()
          if (!content) return { ok: false, text: 'target=topic 需要 content' }
          const written = await writeTopic(personaForTopic, {
            slug: args?.topic,
            summary: args?.summary,
            keywords: args?.keywords,
            content,
          })
          if (!written.ok) return { ok: false, text: written.error }
          const { policy } = readPolicySync(personaForTopic)
          return {
            ok: true,
            text: [
              `已写入主题「${written.slug}」（${written.chars}/${policy.topicMaxChars} 字符）。`,
              `文件：${written.path}`,
              '提示词里只出现一行索引，正文按需读取。',
            ].join('\n'),
          }
        }
        if (!TARGETS.includes(target)) {
          return { ok: false, text: `target 必须是 user、memory 或 topic，收到：${target || '(空)'}` }
        }
        const operations = normalizeOperations(args)
        if (!operations.length) {
          return { ok: false, text: '没有可执行的操作：请给出 operations（或 action 加 content）。' }
        }

        const snapshot = agent?.id ? snapshots.get(agent.id) : undefined
        const persona = snapshot?.persona ?? (await resolvePersona(agent))
        // The policy is the human's contract; it wins over both the roster limits and
        // the plugin config, and a closed tier is refused before anything is read.
        const { policy } = readPolicySync(persona)
        const gate = assertWritable(persona, target)
        if (!gate.ok) return { ok: false, text: gate.error }
        const activeLimits = effectiveLimits(policy, snapshot?.limits ?? limits)

        const current = await readEntries(persona, target)
        const result = applyOperations(current, operations, activeLimits[target], {
          routeThreshold,
          entryMaxChars: policy.entryMaxChars,
        })
        if (!result.ok) {
          const size = result.usage ?? usage(current, activeLimits[target])
          const preview = current.length
            ? current.map((entry, index) => `${index + 1}. ${entry}`).join('\n')
            : '(空)'
          return {
            ok: false,
            text: [
              `${result.error}`,
              '',
              `当前 ${target} 用量：${size.used}/${size.limit} 字符（${size.percent}%）。现有条目：`,
              preview,
            ].join('\n'),
          }
        }

        const file = await writeEntries(persona, target, result.entries)
        // Keep the entry metadata in step with the file. The review does this after
        // its own writes; the tool path did not, so every manual write left the meta
        // map one entry behind and `pnpm audit` reported drift.
        await refreshMeta(persona).catch(() => {})

        // A fact that lands in both tiers is a fact that will drift apart later:
        // the same rule living in user.md and memory.md gets edited in one place and
        // read from the other. Flag it at write time, while the author still knows.
        const added = result.entries.filter((entry) => !current.includes(entry))
        const otherTarget = target === 'user' ? 'memory' : 'user'
        const twins = []
        if (added.length) {
          const otherEntries = await readEntries(persona, otherTarget)
          for (const entry of added) {
            const twin = otherEntries.find((other) => similarity(entry, other) >= 0.8)
            if (twin) twins.push(`${otherTarget} 档已有相近条目：「${twin.slice(0, 40)}」`)
          }
        }

        // Entries refused by the resident budget were handed over instead of
        // dropped, so a write never fails just because a tier is full.
        const diverted = []
        for (const item of result.redirects ?? []) {
          // No slug unless the caller gave one: writeTopic reuses a near-identical
          // topic when it can, so an overflowing entry extends the existing subject
          // instead of minting a per-turn topic with an auto-slug nobody searches for.
          const written = await writeTopic(persona, {
            slug: item.slugHint || args?.topic || undefined,
            summary: String(item.summary ?? args?.summary ?? '').trim(),
            keywords: item.keywords ?? args?.keywords,
            content: item.content,
          })
          diverted.push(written.ok ? `已转存主题「${written.slug}」（常驻已满）` : `转存失败：${written.error}`)
        }
        const rewrote = (result.replaced ?? []).map((item) => `已合并覆盖旧条目：${item.preview}`)

        return {
          ok: true,
          text: [
            `已写入 ${target}（${result.entries.length} 条，${result.usage.used}/${result.usage.limit} 字符，${result.usage.percent}%）。`,
            `文件：${file}`,
            '本会话的系统提示词不会变；这些内容从下一个会话开始注入。',
            ...twins.map((line) => `注意：${line}（同一事实只留一处）`),
            ...rewrote,
            ...diverted,
          ].join('\n'),
        }
      },
    }),
  )

  return {
    /** Exposed for the roster/panel half and for tests. */
    personaId,
    memoryPath: memoryFile(personaId, 'memory'),
  }
}
