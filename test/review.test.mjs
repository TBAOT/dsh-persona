import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, LOG_ROTATE_BYTES, needsRotation } from '../lib/review.js'

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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** Poll until the background review has written the file, instead of guessing a delay. */
async function waitForFile(file, timeoutMs = 4000) {
  const started = Date.now()
  for (;;) {
    try {
      return await readFile(file, 'utf8')
    } catch {
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${file}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}
const emit = (listeners, name, ...args) => Promise.all((listeners.get(name) ?? []).map((handler) => handler(...args)))

// The review is fire-and-forget, so its writes land after `turn-stopping` resolves.
// CI runners (especially Windows + Node 20) are slow enough that a short fixed
// sleep raced the audit write, so give the background work a real window.
const tick = () => new Promise((resolve) => setTimeout(resolve, 250))

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

test('a reloaded instance still reviews the turn it missed', async () => {
  await withTempHome(async (home) => {
    // A previous instance persisted the digest before the plugin was reloaded.
    const dir = path.join(home, 'storages', 'persona-buffers')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'session-1.json'),
      JSON.stringify([{ role: 'user', text: '以后别用 npm，用 pnpm' }]),
      'utf8',
    )

    const host = fakeHost(JSON.stringify({ ops: [{ target: 'memory', action: 'add', content: '项目用 pnpm' }] }))
    apply(host.ctx, { personaId: 'tester' })
    // No session/event for this instance: the turn's messages come from disk.
    await emit(host.listeners, 'agent/turn-stopping', { agent: { id: 'session-1' }, turn: 1 })
    await tick()

    assert.equal(host.calls.length, 1)
    assert.match(host.calls[0].messages[1].content[0].text, /pnpm/)
    const log = await readFile(path.join(home, 'personas', 'tester', 'review', 'log.jsonl'), 'utf8')
    assert.match(log, /"status":"written"/)
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

test('a nearly full memory asks the model to consolidate instead of adding', async () => {
  await withTempHome(async (home) => {
    const dir = path.join(home, 'personas', 'tester', 'memory')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'memory.md'),
      `<!-- dsh-persona v1 target=memory -->\n${'x'.repeat(1200)}\n`,
      'utf8',
    )

    const host = fakeHost(JSON.stringify({ ops: [] }))
    apply(host.ctx, { personaId: 'tester', memoryLimit: 1300 })
    await feedTurn(host)
    await emit(host.listeners, 'agent/turn-stopping', { agent: { id: 'session-1' }, turn: 1 })
    await tick()

    const prompt = host.calls[0].messages[1].content[0].text
    assert.match(prompt, /空间提醒/)
    assert.match(prompt, /优先用 patch/)
  })
})

test('the same turn is reviewed once, and the write leaves a traceable hash', async () => {
  await withTempHome(async (home) => {
    const reply = JSON.stringify({ ops: [{ target: 'memory', action: 'add', content: '项目用 pnpm' }] })
    const host = fakeHost(reply)
    apply(host.ctx, { personaId: 'tester' })
    await feedTurn(host)
    await emit(host.listeners, 'agent/turn-stopping', { agent: { id: 'session-1' }, turn: 7 })
    await tick()
    // A replayed hook for the same turn must not reach the model again.
    await emit(host.listeners, 'agent/turn-stopping', { agent: { id: 'session-1' }, turn: 7 })
    await tick()

    assert.equal(host.calls.length, 1)
    const memory = await readFile(path.join(home, 'personas', 'tester', 'memory', 'memory.md'), 'utf8')
    assert.equal(memory.split('§').length, 1)

    const evidence = await readFile(path.join(home, 'personas', 'tester', 'review', 'evidence.jsonl'), 'utf8')
    const line = JSON.parse(evidence.trim().split('\n')[0])
    assert.equal(line.turn, 7)
    assert.match(line.events[0].hash, /^[0-9a-f]{12}$/)

    const log = await readFile(path.join(home, 'personas', 'tester', 'review', 'log.jsonl'), 'utf8')
    assert.match(log, /duplicate-turn/)
  })
})

test('the audit log rotates once it passes the size limit', () => {
  assert.equal(needsRotation(0), false)
  assert.equal(needsRotation(LOG_ROTATE_BYTES - 1), false)
  assert.equal(needsRotation(LOG_ROTATE_BYTES), true)
  assert.equal(needsRotation(LOG_ROTATE_BYTES * 4), true)
})

test('a written turn leaves per-entry metadata and one metric line', async () => {
  await withTempHome(async (home) => {
    const reply = JSON.stringify({ ops: [{ target: 'memory', action: 'add', content: '项目用 pnpm' }] })
    const host = fakeHost(reply)
    apply(host.ctx, { personaId: 'tester' })
    await feedTurn(host)
    await emit(host.listeners, 'agent/turn-stopping', { agent: { id: 'session-1' }, turn: 3 })
    await tick()

    const meta = JSON.parse(await waitForFile(path.join(home, 'personas', 'tester', 'memory', 'meta.json')))
    assert.equal(Object.keys(meta.entries).length, 1)
    assert.equal(Object.values(meta.entries)[0].turn, 3)

    const metrics = await waitForFile(path.join(home, 'personas', 'tester', 'review', 'metrics.jsonl'))
    const line = JSON.parse(metrics.trim().split('\n').pop())
    assert.equal(line.turn, 3)
    assert.equal(line.resident[0].target, 'memory')
  })
})