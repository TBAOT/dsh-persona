import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply as applyMemory } from '../lib/memory.js'
import { apply as applyReview } from '../lib/review.js'
import { resetRecall } from '../lib/recall.js'
import { writeTopic } from '../lib/topics.js'

/**
 * One Host, both halves: memory injects on `agent/pre-step`, review writes on
 * `agent/turn-stopping`, and the metric they share is the only thing that proves
 * the two are actually connected.
 *
 * This is the end-to-end guard that did not exist while recall was dead — the unit
 * tests around each half were all green, and nothing ever asserted that the turn's
 * metric says "injected".
 */
function fakeHost(reply) {
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
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }
      return undefined
    },
    llm: {
      stream(options) {
        calls.push(options)
        return (async function* generate() {
          yield { type: 'text-delta', text: reply }
          yield { type: 'usage', usage: { inputTokens: 2100, outputTokens: 30, cacheReadTokens: 900 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  return { ctx, listeners, calls }
}

async function withTempHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-e2e-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    // Windows + Node 20 hands back ENOTEMPTY when a background review still holds a
    // handle on the file it just wrote; retrying is the documented fix, and CI caught it.
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const emit = (listeners, name, ...args) => Promise.all((listeners.get(name) ?? []).map((handler) => handler(...args)))
const tick = () => new Promise((resolve) => setTimeout(resolve, 250))

/** Poll instead of sleeping: the review writes in the background, slower on CI. */
async function waitForFile(file, timeoutMs = 5000) {
  const started = Date.now()
  for (;;) {
    try {
      const text = await readFile(file, 'utf8')
      if (text.trim()) return text
    } catch {
      /* not there yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${file}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('a turn injects recall and the review records it as injected', async () => {
  await withTempHome(async (home) => {
    resetRecall()
    const host = fakeHost(JSON.stringify({ ops: [{ target: 'memory', action: 'add', content: '清理脚本先看 %TEMP%' }] }))
    applyMemory(host.ctx, { personaId: 'tester' })
    applyReview(host.ctx, { personaId: 'tester' })
    await writeTopic('tester', {
      slug: '磁盘与清理',
      summary: '清理脚本与会话归档判据',
      keywords: ['清理脚本', '能不能删'],
      content: 'clean-dsh.ps1 清 %TEMP%，dsh-runtimes 不动。',
    })

    const agent = { id: 'session-e2e' }
    const turn = 7
    const decision = { kind: 'enter', messages: [{ role: 'user', content: '清理脚本都清哪些目录' }] }
    const out = await emit(host.listeners, 'agent/pre-step', { agent, turn, step: 1 }, async () => decision)
    assert.equal(out[0].messages[0].content.includes('可能相关的主题'), true, '召回块必须进到这一轮的消息里')

    // A real turn runs several steps. Step 2 correctly skips — and used to overwrite
    // step 1's record, turning a healthy turn into `skipped` (seen live after 0.10.4).
    const later = { kind: 'enter', messages: out[0].messages }
    const second = await emit(host.listeners, 'agent/pre-step', { agent, turn, step: 2 }, async () => later)
    // Step 2 must not inject a second block. It may return a new object (stale blocks
    // are stripped), so compare the content, not the reference.
    assert.equal(second[0].messages[0].content.match(/可能相关的主题/g)?.length ?? 0, 1)

    await emit(host.listeners, 'session/event', { id: 'session-e2e' }, {
      type: 'user/message',
      message: { content: [{ type: 'text', text: '清理脚本都清哪些目录' }] },
    })
    await emit(host.listeners, 'agent/turn-stopping', { agent, turn })

    const file = path.join(home, 'personas', 'tester', 'review', 'metrics.jsonl')
    const metric = JSON.parse((await waitForFile(file)).trim().split('\n').pop())
    assert.equal(metric.recall.outcome, 'injected', '指标必须如实反映这一轮注入过')
    assert.ok(metric.recall.chars > 0)
    assert.deepEqual(metric.recall.topics, ['磁盘与清理'])
    assert.equal(metric.recall.turn, turn)
    assert.deepEqual(metric.tokens, { in: 2100, out: 30, cacheRead: 900 })
    assert.equal(metric.usageMissing, false)
  })
})

test('a turn whose step is rejected never claims an injection', async () => {
  await withTempHome(async (home) => {
    resetRecall()
    const host = fakeHost(JSON.stringify({ ops: [] }))
    applyMemory(host.ctx, { personaId: 'tester' })
    applyReview(host.ctx, { personaId: 'tester' })
    await writeTopic('tester', { slug: '磁盘与清理', summary: '清理脚本', content: 'clean-dsh.ps1。' })

    const agent = { id: 'session-reject' }
    const rejected = { kind: 'reject' }
    const out = await emit(host.listeners, 'agent/pre-step', { agent, turn: 3, step: 1 }, async () => rejected)
    assert.equal(out[0], rejected)

    await emit(host.listeners, 'session/event', { id: 'session-reject' }, {
      type: 'user/message',
      message: { content: [{ type: 'text', text: '顺便记一下清理脚本的路径' }] },
    })
    await emit(host.listeners, 'agent/turn-stopping', { agent, turn: 3 })
    const metric = JSON.parse(
      (await waitForFile(path.join(home, 'personas', 'tester', 'review', 'metrics.jsonl'))).trim().split('\n').pop(),
    )
    assert.notEqual(metric.recall.outcome, 'injected')
  })
})
