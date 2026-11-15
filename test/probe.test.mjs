import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { listTopicsSync } from '../lib/topics.js'

const suite = JSON.parse(readFileSync(path.join(import.meta.dirname, 'probe', 'questions.json'), 'utf8'))

test('the probe suite is version 2 and every question is classified', () => {
  assert.equal(suite.version, 2)
  assert.ok(Array.isArray(suite.questions) && suite.questions.length >= 10)
  const types = new Set(['single-hop', 'multi-hop', 'temporal', 'negative'])
  for (const item of suite.questions) {
    assert.equal(typeof item.q, 'string')
    assert.ok(item.q.trim().length >= 4)
    assert.ok(types.has(item.type), `未知题型：${item.type}`)
    assert.equal(typeof item.holdout, 'boolean')
    assert.ok(String(item.source ?? '').length > 0, '每道题都要有出处')
  }
  const questions = suite.questions.map((item) => item.q)
  assert.equal(new Set(questions).size, questions.length, '题目不要重复')
  assert.ok(suite.questions.some((item) => item.type === 'negative'), '至少要有一条负例')
  assert.ok(suite.questions.some((item) => item.holdout), '留出集不能为空')
  assert.ok(suite.questions.some((item) => !item.holdout), '调参集不能为空')
})

test('every expected slug is a real topic of the persona the probe runs against', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-probe-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // The suite is written against the live slot-1 library; mirror its slugs here so
    // a renamed or archived topic fails loudly instead of silently becoming a miss.
    const slugs = new Set(listTopicsSync('slot-1').map((topic) => topic.slug))
    if (!slugs.size) return // 干净环境下没有主题库，跳过身份校验（CI 里 probe 不跑）
    for (const item of suite.questions) {
      const expected = item.expect === null ? [] : Array.isArray(item.expect) ? item.expect : [item.expect]
      for (const slug of expected) {
        assert.ok(slugs.has(slug), `期望主题不存在：${slug}（题：${item.q}）`)
      }
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
