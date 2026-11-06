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
  readEntries,
  renderBlock,
  sanitizeId,
  usage,
  writeEntries,
} from './store.js'
import { limitsForPersona, readIndex, resolvePersonaForCwd } from './roster.js'

export const name = 'persona-memory'
export const inject = ['tools', 'systemPrompt']

const TOOL_DESCRIPTION = [
  '维护当前角色的长期记忆，分两档：',
  '• target=user —— 用户画像：对方是谁、偏好、沟通方式、忌讳。',
  '• target=memory —— 角色自己的笔记：环境事实、项目约定、踩过的坑、做完的事。',
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

  /** Frozen snapshot per session, loaded once on agent creation. */
  const snapshots = new Map()

  /**
   * Which persona serves this agent?
   *
   * The roster maps workspaces to personas, and a session's working directory
   * is the only stable signal we get for free. So a session opened inside a
   * bound workspace uses that persona; anything else falls back to the row's
   * configured `personaId`.
   */
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
    return personaId
  }

  const loadSnapshot = async (agent) => {
    if (!agent?.id) return
    const persona = await resolvePersona(agent)
    const [user, memory, index] = await Promise.all([
      readEntries(persona, 'user'),
      readEntries(persona, 'memory'),
      readIndex(process.env).catch(() => undefined),
    ])
    const personaLimits = index ? limitsForPersona(index, persona, limits) : limits
    snapshots.set(agent.id, { persona, user, memory, limits: personaLimits })
  }

  ctx.on('agent/created', ({ agent }) => {
    if (!inject) return
    loadSnapshot(agent).catch((error) => {
      ctx.logger?.warn?.(`[dsh-persona] 读取记忆失败：${error instanceof Error ? error.message : String(error)}`)
    })
  })

  const snapshotOf = (agent) => (agent?.id ? snapshots.get(agent.id) : undefined)

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
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'memory',
      description: TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: TARGETS,
            description: 'user = 用户画像；memory = 角色自己的笔记。',
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
        if (!TARGETS.includes(target)) {
          return { ok: false, text: `target 必须是 user 或 memory，收到：${target || '(空)'}` }
        }
        const operations = normalizeOperations(args)
        if (!operations.length) {
          return { ok: false, text: '没有可执行的操作：请给出 operations（或 action 加 content）。' }
        }

        const agent = exec?.agent
        const snapshot = agent?.id ? snapshots.get(agent.id) : undefined
        const persona = snapshot?.persona ?? (await resolvePersona(agent))
        const activeLimits = snapshot?.limits ?? limits

        const current = await readEntries(persona, target)
        const result = applyOperations(current, operations, activeLimits[target])
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

        return {
          ok: true,
          text: [
            `已写入 ${target}（${result.entries.length} 条，${result.usage.used}/${result.usage.limit} 字符，${result.usage.percent}%）。`,
            `文件：${file}`,
            '本会话的系统提示词不会变；这些内容从下一个会话开始注入。',
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
