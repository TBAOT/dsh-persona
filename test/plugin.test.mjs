import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/memory.js'
import { recallSummary, resetRecall } from '../lib/recall.js'
import { readMetaSync } from '../lib/store.js'
import { writeTopic } from '../lib/topics.js'

/** Minimal Host stand-in: just the seams this plugin touches. */
function fakeHost() {
  const tools = new Map()
  const sections = new Map()
  const listeners = new Map()
  const ctx = {
    logger: { warn() {}, info() {} },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return () => (typeof dispose === 'function' ? dispose() : undefined)
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        sections.set(section.name, section)
        return () => {}
      },
    },
  }
  return { ctx, tools, sections, listeners }
}

async function withTempHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

/** The plugin no longer preloads at creation; keep the call sites harmless. */
const fireCreated = (host, agent) => (host.listeners.get('agent/created') ?? []).forEach((handler) => handler({ agent }))

test('registers one memory tool and three prompt sections', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { personaId: 'tester' })
    assert.deepEqual([...host.tools.keys()], ['memory'])
    assert.deepEqual([...host.sections.keys()].sort(), ['persona:memory', 'persona:topics', 'persona:user'])
  })
})

test('writes entries to the persona directory and reports usage', async () => {
  await withTempHome(async (home) => {
    const host = fakeHost()
    apply(host.ctx, { personaId: 'tester' })
    const tool = host.tools.get('memory')
    const agent = { id: 'session-1' }
    fireCreated(host, agent)
    await tick()

    const result = await tool.execute(
      { target: 'user', operations: [{ action: 'add', content: '偏好简洁回答' }] },
      { agent },
    )
    assert.equal(result.ok, true)
    const file = path.join(home, 'personas', 'tester', 'memory', 'user.md')
    const text = await readFile(file, 'utf8')
    assert.match(text, /^<!-- dsh-persona v1 target=user -->/)
    assert.match(text, /偏好简洁回答/)
  })
})

test('prompt section is empty before the snapshot loads, then renders the block', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { personaId: 'tester' })
    const agent = { id: 'session-2' }
    const userSection = host.sections.get('persona:user')
    const memorySection = host.sections.get('persona:memory')

    assert.equal(userSection.text({ agent }), '')
    fireCreated(host, agent)
    await tick()
    assert.equal(userSection.text({ agent }), '')
    assert.equal(memorySection.text({ agent }), '')

    const tool = host.tools.get('memory')
    await tool.execute({ target: 'memory', operations: [{ action: 'add', content: '项目用 pnpm' }] }, { agent })
    // Frozen snapshot: the current session still renders the old (empty) text.
    assert.equal(memorySection.text({ agent }), '')
  })
})

test('a later session sees what the previous one wrote', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { personaId: 'tester' })
    const tool = host.tools.get('memory')
    const first = { id: 'session-a' }
    fireCreated(host, first)
    await tick()
    await tool.execute({ target: 'memory', operations: [{ action: 'add', content: '项目用 pnpm' }] }, { agent: first })

    const second = { id: 'session-b' }
    fireCreated(host, second)
    await tick()
    const block = host.sections.get('persona:memory').text({ agent: second })
    assert.match(block, /长期记忆/)
    assert.match(block, /项目用 pnpm/)
  })
})

test('over-limit write is refused and reports the current entries', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { personaId: 'tester', userLimit: 150 })
    const tool = host.tools.get('memory')
    const agent = { id: 'session-c' }
    fireCreated(host, agent)
    await tick()

    const result = await tool.execute(
      // Two entries that each fit the 120-character rule but together blow the tier.
      {
        target: 'user',
        operations: [
          { action: 'add', content: 'x'.repeat(100) },
          { action: 'add', content: 'y'.repeat(100) },
        ],
      },
      { agent },
    )
    assert.equal(result.ok, false)
    assert.match(result.text, /超出上限/)
    assert.match(result.text, /当前 user 用量/)
  })
})

test('unknown target is rejected', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { personaId: 'tester' })
    const tool = host.tools.get('memory')
    const result = await tool.execute({ target: 'nope', operations: [] }, { agent: { id: 'x' } })
    assert.equal(result.ok, false)
    assert.match(result.text, /user、memory 或 topic/)
  })
})

/**
 * Regression guard for the bug that shipped in 0.8.0–0.8.3: the whole recall
 * body sat behind a literal `\n` inside a `//` comment, so `block` was never
 * declared, every turn threw a ReferenceError and an empty `catch` ate it. The
 * metrics read `recallChars: 0` for nine versions and nothing failed.
 */
test('the pre-step hook injects a recall block into the step it is entering', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    resetRecall()
    apply(host.ctx, { personaId: 'tester' })
    await writeTopic('tester', {
      slug: '磁盘与清理',
      summary: '清理脚本与会话归档判据',
      content: 'clean-dsh.ps1 清 %TEMP%，dsh-runtimes 不动。',
    })

    const handler = (host.listeners.get('agent/pre-step') ?? [])[0]
    assert.equal(typeof handler, 'function', 'pre-step 监听器必须注册')

    const agent = { id: 'session-recall' }
    const decision = { kind: 'enter', messages: [{ role: 'user', content: '清理脚本都清哪些目录' }] }
    const out = await handler(
      { agent, turn: 1, step: 1, messages: decision.messages, signal: new AbortController().signal },
      async () => decision,
    )

    assert.equal(out.kind, 'enter')
    assert.notEqual(out, decision, '注入后返回的必须是新的 decision')
    assert.match(out.messages[0].content, /可能相关的主题/)
    assert.match(out.messages[0].content, /磁盘与清理/)
    assert.equal(decision.messages[0].content, '清理脚本都清哪些目录', '不得改写传进来的消息')

    const summary = recallSummary()
    assert.equal(summary.outcome, 'injected')
    assert.deepEqual(summary.topics, ['磁盘与清理'])
    assert.ok(summary.chars > 0)
    assert.equal(summary.turn, 1)
  })
})

test('recall injects once per turn and never into a rejected step', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    resetRecall()
    apply(host.ctx, { personaId: 'tester' })
    await writeTopic('tester', { slug: '磁盘与清理', summary: '清理脚本与会话归档判据', content: 'clean-dsh.ps1 清 %TEMP%。' })
    const handler = (host.listeners.get('agent/pre-step') ?? [])[0]
    const agent = { id: 'session-once' }

    const first = { kind: 'enter', messages: [{ role: 'user', content: '清理脚本都清哪些目录' }] }
    const once = await handler({ agent, turn: 5, step: 1 }, async () => first)
    assert.equal(once.messages[0].content.match(/可能相关的主题/g).length, 1)

    // Same turn, second step: the block from step 1 is already in the history,
    // and re-injecting would double its cost for no gain.
    const second = { kind: 'enter', messages: [{ role: 'user', content: '清理脚本都清哪些目录' }] }
    const twice = await handler({ agent, turn: 5, step: 2 }, async () => second)
    assert.equal(twice, second)
    assert.equal(recallSummary().outcome, 'skipped')

    const rejected = { kind: 'reject' }
    const out = await handler({ agent, turn: 6, step: 1 }, async () => rejected)
    assert.equal(out, rejected)
  })
})

test('a tool write keeps the entry metadata in step with the file', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { personaId: 'tester' })
    const tool = host.tools.get('memory')
    const agent = { id: 'session-meta' }
    fireCreated(host, agent)
    await tick()
    await tool.execute({ target: 'memory', operations: [{ action: 'add', content: '项目一律用 pnpm' }] }, { agent })
    const meta = readMetaSync('tester')
    const active = Object.values(meta.entries ?? {}).filter((record) => record.status === 'active')
    assert.equal(active.length, 1, '工具写入后 meta 应当有这条的 active 记录')
  })
})

test('the same fact landing in both tiers is flagged at write time', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { personaId: 'tester' })
    const tool = host.tools.get('memory')
    const agent = { id: 'session-twin' }
    fireCreated(host, agent)
    await tick()

    await tool.execute({ target: 'user', operations: [{ action: 'add', content: '项目一律用 pnpm 安装依赖，不生成锁文件' }] }, { agent })
    const result = await tool.execute(
      { target: 'memory', operations: [{ action: 'add', content: '项目一律用 pnpm 安装依赖，不生成锁文件（本机约定）' }] },
      { agent },
    )
    assert.equal(result.ok, true)
    assert.match(result.text, /已有相近条目/)
    assert.match(result.text, /user 档/)
  })
})

test('a patch that restates the surrounding entry is refused, not doubled', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { personaId: 'tester' })
    const tool = host.tools.get('memory')
    const agent = { id: 'session-patch' }
    fireCreated(host, agent)
    await tick()
    await tool.execute(
      { target: 'memory', operations: [{ action: 'add', content: '今天补了摘要修复，实例在 topics/教训.md' }] },
      { agent },
    )
    const result = await tool.execute(
      {
        target: 'memory',
        operations: [
          {
            action: 'patch',
            old_text: '实例在 topics/教训.md',
            content: '今天补了摘要修复，实例在 topics/教训.md（已修）',
          },
        ],
      },
      { agent },
    )
    assert.equal(result.ok, false)
    assert.match(result.text, /复述|重复/)
  })
})

test('an add that looks like a rewrite reports the entry it replaced', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { personaId: 'tester' })
    const tool = host.tools.get('memory')
    const agent = { id: 'session-rewrite' }
    fireCreated(host, agent)
    await tick()
    await tool.execute({ target: 'memory', operations: [{ action: 'add', content: '项目用 npm 装依赖，不要用别的' }] }, { agent })
    const result = await tool.execute(
      { target: 'memory', operations: [{ action: 'add', content: '项目用 pnpm 装依赖，不要用别的' }] },
      { agent },
    )
    assert.equal(result.ok, true)
    assert.match(result.text, /已合并覆盖旧条目/)
    assert.match(result.text, /npm/)
  })
})
