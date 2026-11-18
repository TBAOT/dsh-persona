import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply as applyMemory } from '../lib/memory.js'
import { assertWritable, DEFAULT_POLICY, effectiveLimits, isReadOnly, readPolicySync } from '../lib/policy.js'
import { writeTopic, writeTopicManifest } from '../lib/topics.js'

async function withTempHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-kit-policy-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

async function writePolicy(persona, policy) {
  const dir = path.join(process.env.DSH_HOME, 'personas', persona, 'memory')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'policy.json'), typeof policy === 'string' ? policy : JSON.stringify(policy), 'utf8')
}

const fakeHost = () => {
  const listeners = new Map()
  const tools = new Map()
  return {
    tools,
    ctx: {
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
      systemPrompt: { section: () => () => {}, context: () => () => {} },
    },
    listeners,
  }
}

test('no policy file means the defaults, and nothing is closed', async () => {
  await withTempHome(async () => {
    const { policy, warning, present } = readPolicySync('tester')
    assert.equal(present, false)
    assert.equal(warning, null)
    assert.deepEqual(policy, DEFAULT_POLICY)
    assert.deepEqual(assertWritable('tester', 'user'), { ok: true })
  })
})

test('a broken policy falls back to defaults with a warning instead of failing', async () => {
  await withTempHome(async () => {
    await writePolicy('tester', '{ not json')
    const { policy, warning } = readPolicySync('tester')
    assert.match(warning, /不是合法 JSON/)
    assert.equal(policy.entryMaxChars, DEFAULT_POLICY.entryMaxChars)
    assert.equal(isReadOnly(policy, 'user'), false)
  })
})

test('read-only tiers refuse writes, other tiers keep working', async () => {
  await withTempHome(async () => {
    await writePolicy('tester', { version: 1, readOnly: ['user'] })
    const host = fakeHost()
    applyMemory(host.ctx, { personaId: 'tester' })
    const tool = host.tools.get('memory')
    const agent = { id: 'session-policy' }

    const refused = await tool.execute({ target: 'user', operations: [{ action: 'add', content: '不该写进去' }] }, { agent })
    assert.equal(refused.ok, false)
    assert.match(refused.text, /只读/)

    const allowed = await tool.execute({ target: 'memory', operations: [{ action: 'add', content: '这是可以写的' }] }, { agent })
    assert.equal(allowed.ok, true)
  })
})

test('the policy wins over roster limits and can tighten the entry cap', async () => {
  await withTempHome(async () => {
    await writePolicy('tester', { version: 1, entryMaxChars: 20, limits: { user: 100, memory: 500 } })
    const { policy } = readPolicySync('tester')
    assert.deepEqual(effectiveLimits(policy, { user: 1375, memory: 3000 }), { user: 100, memory: 500 })

    const host = fakeHost()
    applyMemory(host.ctx, { personaId: 'tester' })
    const tool = host.tools.get('memory')
    const agent = { id: 'session-cap' }
    const tooLong = await tool.execute(
      { target: 'memory', operations: [{ action: 'add', content: '超过上限'.repeat(6) }] },
      { agent },
    )
    assert.equal(tooLong.ok, false)
    assert.match(tooLong.text, /20 字上限/)
  })
})

test('a read-only topic library only accepts the human write path', async () => {
  await withTempHome(async () => {
    await writePolicy('tester', { version: 1, readOnly: ['topic'] })
    const refused = await writeTopic('tester', { slug: 'blocked', content: 'agent 不该写进来' })
    assert.equal(refused.ok, false)
    assert.match(refused.error, /只读/)

    const allowed = await writeTopic('tester', { slug: 'human', content: '人写的', byHuman: true })
    assert.equal(allowed.ok, true)
    await writeTopicManifest('tester')
  })
})
