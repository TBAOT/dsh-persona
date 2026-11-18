import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { compatFile, persistCompat, probeHost, readCompatSync, resetCompat } from '../lib/compat.js'
import { apply as applyMemory } from '../lib/memory.js'
import { resetRecall } from '../lib/recall.js'
import { writeTopic } from '../lib/topics.js'

const fullHost = () => ({
  logger: { warn() {}, info() {} },
  on: () => () => {},
  effect: (fn) => {
    const dispose = fn()
    return () => (typeof dispose === 'function' ? dispose() : undefined)
  },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => () => {}, context: () => () => {} },
  llm: { stream: () => {} },
})

test('a complete host is reported compatible and uses runtime context', () => {
  resetCompat()
  const probe = probeHost(fullHost())
  assert.equal(probe.ok, true)
  assert.deepEqual(probe.missing, [])
  assert.deepEqual(probe.degraded, [])
  assert.equal(probe.recallMode, 'runtime-context')
})

test('a host without runtime context is degraded, not broken', () => {
  resetCompat()
  const ctx = fullHost()
  delete ctx.systemPrompt.context
  const probe = probeHost(ctx)
  assert.equal(probe.ok, true)
  assert.deepEqual(probe.degraded, ['runtimeContext'])
  assert.equal(probe.recallMode, 'user-message')
})

test('a host missing required seams is not compatible', () => {
  resetCompat()
  const ctx = fullHost()
  delete ctx.on
  const probe = probeHost(ctx)
  assert.equal(probe.ok, false)
  assert.ok(probe.missing.includes('events'))
})

test('the probe survives to disk for the CLI to read', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-kit-compat-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    resetCompat()
    const probe = probeHost(fullHost())
    const file = persistCompat(probe)
    assert.equal(file, compatFile())
    const read = readCompatSync()
    assert.equal(read.ok, true)
    assert.equal(read.recallMode, 'runtime-context')
    assert.ok(read.package, '应当带上插件版本')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('a failing initialisation is contained, never thrown at the Host', async () => {
  // A Host that renamed `tools.register` would make the plugin throw while activating;
  // an exception there can keep DSH from starting. apply() must swallow it instead.
  const ctx = {
    logger: { warn() {}, info() {} },
    on: () => () => {},
    effect: (fn) => fn(),
    get tools() {
      throw new Error('boom: tools seam changed')
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
  }
  let result
  assert.doesNotThrow(() => {
    result = applyMemory(ctx, { personaId: 'tester' })
  })
  assert.equal(result.disabled, true)
  assert.match(result.error, /boom/)
})

test('without runtime context the plugin falls back to the user message', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-kit-compat-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    resetRecall()
    const listeners = new Map()
    const ctx = {
      logger: { warn() {}, info() {} },
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(handler)
        return () => {}
      },
      effect: (fn) => {
        const dispose = fn()
        return () => (typeof dispose === 'function' ? dispose() : undefined)
      },
      tools: { register: () => () => {} },
      // No `context`: this is the old Host shape.
      systemPrompt: { section: () => () => {} },
    }
    applyMemory(ctx, { personaId: 'tester' })
    await writeTopic('tester', { slug: '磁盘与清理', summary: '清理脚本与会话归档判据', content: 'clean-dsh.ps1 清 %TEMP%。' })

    const handler = (listeners.get('agent/pre-step') ?? [])[0]
    const decision = { kind: 'enter', messages: [{ role: 'user', content: '清理脚本都清哪些目录' }] }
    const out = await handler({ agent: { id: 'session-degraded' }, turn: 1, step: 1 }, async () => decision)
    assert.match(out.messages[0].content, /可能相关的主题/, '降级时必须把块放进消息，否则召回就没了')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
