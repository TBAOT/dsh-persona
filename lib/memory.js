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
  visibleEntries,
  renderBlock,
  sanitizeId,
  usage,
  writeEntries,
} from './store.js'
import { limitsForPersona, readIndexSync, resolvePersonaForCwd } from './roster.js'
import { TOPIC_MAX_CHARS, autoSlug, listTopicsSync, renderTopicIndex, writeTopic } from './topics.js'

export const name = 'persona-memory'
export const inject = ['tools', 'systemPrompt']

const TOOL_DESCRIPTION = [
  '维护当前角色的长期记忆，分三档（user / memory 为常驻，topic 为按需读取的细节）：',
  '• target=user —— 用户画像：对方是谁、偏好、沟通方式、忌讳。',
  '• target=memory —— 角色自己的笔记：环境事实、项目约定、踩过的坑、做完的事。',
  '• target=topic —— 细节：操作步骤、排查过程、项目背景。要带 topic（短 slug）与 summary（≤30 字）；同一主题复用同一 slug。',
  '',
  '操作只有三种：',
  '• add —— 追加一条（与已有条目完全重复会被拒绝）。',
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

export function apply(ctx, config = {}) {
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
  const topicsLimit = Number(config.topicsIndexLimit ?? 500)

  /** Frozen snapshot per session, read synchronously the first time it is needed. */
  const snapshots = new Map()

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
      topics: topicsEnabled ? renderTopicIndex(listTopicsSync(persona), topicsLimit) : '',
    }
    snapshots.set(agent.id, snapshot)
    return snapshot
  }

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id) snapshots.delete(agent.id)
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
          const written = await writeTopic(personaForTopic, { slug: args?.topic, summary: args?.summary, content })
          if (!written.ok) return { ok: false, text: written.error }
          return {
            ok: true,
            text: [
              `已写入主题「${written.slug}」（${written.chars}/${TOPIC_MAX_CHARS} 字符）。`,
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
        const activeLimits = snapshot?.limits ?? limits

        const current = await readEntries(persona, target)
        const result = applyOperations(current, operations, activeLimits[target], { routeThreshold })
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

        // Entries refused by the resident budget were handed over instead of
        // dropped, so a write never fails just because a tier is full.
        const diverted = []
        for (const item of result.redirects ?? []) {
          const slug = String(args?.topic ?? '').trim() || autoSlug(item.content)
          const written = await writeTopic(persona, { slug, summary: args?.summary, content: item.content })
          diverted.push(written.ok ? `已转存主题「${written.slug}」（常驻已满）` : `转存失败：${written.error}`)
        }

        return {
          ok: true,
          text: [
            `已写入 ${target}（${result.entries.length} 条，${result.usage.used}/${result.usage.limit} 字符，${result.usage.percent}%）。`,
            `文件：${file}`,
            '本会话的系统提示词不会变；这些内容从下一个会话开始注入。',
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
