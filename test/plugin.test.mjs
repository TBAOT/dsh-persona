import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/memory.js'

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

test('registers one memory tool and two prompt sections', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { personaId: 'tester' })
    assert.deepEqual([...host.tools.keys()], ['memory'])
    assert.deepEqual([...host.sections.keys()].sort(), ['persona:memory', 'persona:user'])
  })
})

test('writes entries to the persona directory and reports usage', async () => {
  await withTempHome(async (home) => {
    const host = fakeHost()
    apply(host.ctx, { personaId: 'tester' })
    const tool = host.tools.get('memory')
    const agent = { id: 'session-1' }
    host.listeners.get('agent/created').forEach((handler) => handler({ agent }))
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
    host.listeners.get('agent/created').forEach((handler) => handler({ agent }))
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
    host.listeners.get('agent/created').forEach((handler) => handler({ agent: first }))
    await tick()
    await tool.execute({ target: 'memory', operations: [{ action: 'add', content: '项目用 pnpm' }] }, { agent: first })

    const second = { id: 'session-b' }
    host.listeners.get('agent/created').forEach((handler) => handler({ agent: second }))
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
    host.listeners.get('agent/created').forEach((handler) => handler({ agent }))
    await tick()

    const result = await tool.execute(
      { target: 'user', operations: [{ action: 'add', content: 'x'.repeat(200) }] },
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
    assert.match(result.text, /user 或 memory/)
  })
})
