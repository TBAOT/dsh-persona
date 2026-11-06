import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/review.js'

function fakeHost(responseText) {
  const listeners = new Map()
  const calls = []
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
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }
      }
      return undefined
    },
    llm: {
      stream(options) {
        calls.push(options)
        return (async function* generate() {
          yield { type: 'text-delta', text: responseText }
          yield { type: 'finish' }
        })()
      },
    },
  }
  return { ctx, listeners, calls }
}

async function withTempHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-review-'))
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

const emit = (listeners, name, ...args) => Promise.all((listeners.get(name) ?? []).map((handler) => handler(...args)))

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function feedTurn(host, sessionId = 'session-1') {
  const session = { id: sessionId }
  return emit(host.listeners, 'session/event', session, {
    type: 'user/message',
    message: { content: [{ type: 'text', text: '以后别用 npm，用 pnpm' }] },
  })
}

test('a turn produces memory edits through the model', async () => {
  await withTempHome(async (home) => {
    const reply = JSON.stringify({ ops: [{ target: 'memory', action: 'add', content: '项目用 pnpm 而不是 npm' }] })
    const host = fakeHost(reply)
    apply(host.ctx, { personaId: 'tester' })
    await feedTurn(host)
    await emit(host.listeners, 'agent/turn-stopping', { agent: { id: 'session-1' }, turn: 1 })
    await tick()

    assert.equal(host.calls.length, 1)
    const file = path.join(home, 'personas', 'tester', 'memory', 'memory.md')
    const text = await readFile(file, 'utf8')
    assert.match(text, /项目用 pnpm 而不是 npm/)

    const log = await readFile(path.join(home, 'personas', 'tester', 'review', 'log.jsonl'), 'utf8')
    assert.match(log, /"ok":true/)
    assert.match(log, /"applied"/)
  })
})

test('disabled review writes nothing', async () => {
  await withTempHome(async (home) => {
    const host = fakeHost(JSON.stringify({ ops: [] }))
    apply(host.ctx, { personaId: 'tester', enabled: false })
    await feedTurn(host)
    await emit(host.listeners, 'agent/turn-stopping', { agent: { id: 'session-1' }, turn: 1 })
    await tick()
    assert.equal(host.calls.length, 0)
    await assert.rejects(stat(path.join(home, 'personas', 'tester', 'memory', 'memory.md')))
  })
})

test('dry run records ops but writes no memory', async () => {
  await withTempHome(async (home) => {
    const reply = JSON.stringify({ ops: [{ target: 'user', action: 'add', content: '偏好简洁' }] })
    const host = fakeHost(reply)
    apply(host.ctx, { personaId: 'tester', dryRun: true })
    await feedTurn(host)
    await emit(host.listeners, 'agent/turn-stopping', { agent: { id: 'session-1' }, turn: 1 })
    await tick()

    await assert.rejects(stat(path.join(home, 'personas', 'tester', 'memory', 'user.md')))
    const log = await readFile(path.join(home, 'personas', 'tester', 'review', 'log.jsonl'), 'utf8')
    assert.match(log, /"dryRun":true/)
  })
})

test('malformed model output is recorded, not applied', async () => {
  await withTempHome(async (home) => {
    const host = fakeHost('这是一段解释而不是 JSON')
    apply(host.ctx, { personaId: 'tester' })
    await feedTurn(host)
    await emit(host.listeners, 'agent/turn-stopping', { agent: { id: 'session-1' }, turn: 1 })
    await tick()

    const log = await readFile(path.join(home, 'personas', 'tester', 'review', 'log.jsonl'), 'utf8')
    assert.match(log, /"ok":true/)
    assert.match(log, /no-ops|parse-failed/)
  })
})

test('everyTurns skips intermediate turns', async () => {
  await withTempHome(async () => {
    const reply = JSON.stringify({ ops: [{ target: 'memory', action: 'add', content: 'x' }] })
    const host = fakeHost(reply)
    apply(host.ctx, { personaId: 'tester', everyTurns: 3 })
    for (let turn = 1; turn <= 2; turn += 1) {
      await feedTurn(host)
      await emit(host.listeners, 'agent/turn-stopping', { agent: { id: 'session-1' }, turn })
      await tick()
    }
    assert.equal(host.calls.length, 0)
    await feedTurn(host)
    await emit(host.listeners, 'agent/turn-stopping', { agent: { id: 'session-1' }, turn: 3 })
    await tick()
    assert.equal(host.calls.length, 1)
  })
})

test('over-limit edits are rejected per target and recorded', async () => {
  await withTempHome(async (home) => {
    const reply = JSON.stringify({ ops: [{ target: 'user', action: 'add', content: 'x'.repeat(200) }] })
    const host = fakeHost(reply)
    apply(host.ctx, { personaId: 'tester', userLimit: 150 })
    await feedTurn(host)
    await emit(host.listeners, 'agent/turn-stopping', { agent: { id: 'session-1' }, turn: 1 })
    await tick()

    const log = await readFile(path.join(home, 'personas', 'tester', 'review', 'log.jsonl'), 'utf8')
    assert.match(log, /"rejected"/)
    assert.match(log, /超出上限/)
    assert.match(log, /"status":"rejected"/)
  })
})
