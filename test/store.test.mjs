import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyOperation,
  applyOperations,
  withPersonaLock,
  formatEntries,
  inspectContent,
  parseEntries,
  renderBlock,
  sanitizeId,
  totalChars,
  usage,
} from '../lib/store.js'

test('parse and format round-trip', () => {
  const entries = ['第一件事\n第二行', '第二件事']
  const text = formatEntries('memory', entries)
  assert.match(text, /^<!-- dsh-persona v1 target=memory -->/)
  assert.deepEqual(parseEntries(text), entries)
})

test('empty file parses to no entries', () => {
  assert.deepEqual(parseEntries(''), [])
  assert.deepEqual(parseEntries('<!-- dsh-persona v1 target=user -->\n'), [])
})

test('add rejects exact duplicate', () => {
  const first = applyOperation([], { action: 'add', content: '偏好简洁回答' })
  assert.equal(first.ok, true)
  const again = applyOperation(first.entries, { action: 'add', content: '偏好简洁回答' })
  assert.equal(again.ok, false)
  assert.match(again.error, /完全相同/)
})

test('patch replaces only the matched span', () => {
  const result = applyOperation(['用户用 npm 装依赖'], {
    action: 'patch',
    old_text: 'npm',
    content: 'pnpm',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.entries, ['用户用 pnpm 装依赖'])
})

test('patch refuses ambiguous match', () => {
  const result = applyOperation(['npm 和 npm'], { action: 'patch', old_text: 'npm', content: 'pnpm' })
  assert.equal(result.ok, false)
  assert.match(result.error, /命中 2 处/)
})

test('remove deletes exactly one entry', () => {
  const result = applyOperation(['保留这条', '删掉这条'], { action: 'remove', old_text: '删掉' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.entries, ['保留这条'])
})

test('remove refuses ambiguous match across entries', () => {
  const result = applyOperation(['项目 A', '项目 B'], { action: 'remove', old_text: '项目' })
  assert.equal(result.ok, false)
  assert.match(result.error, /多个条目/)
})

test('batch over the limit is refused and reports the deficit', () => {
  const limit = 20
  const result = applyOperations([], [{ action: 'add', content: 'x'.repeat(30) }], limit)
  assert.equal(result.ok, false)
  assert.ok(result.overflow > 0)
  assert.match(result.error, /超出/)
})

test('batch may free space then add within the limit', () => {
  const limit = 30
  const start = ['a'.repeat(20)]
  const result = applyOperations(
    start,
    [
      { action: 'remove', old_text: 'a'.repeat(20) },
      { action: 'add', content: 'b'.repeat(20) },
    ],
    limit,
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.entries, ['b'.repeat(20)])
})

test('invisible characters are refused', () => {
  const result = inspectContent('正常文本\u200B隐藏')
  assert.equal(result.ok, false)
  assert.match(result.error, /不可见/)
})

test('secret-shaped content is refused', () => {
  assert.equal(inspectContent('key sk-' + 'a'.repeat(24)).ok, false)
  assert.equal(inspectContent('-----BEGIN RSA PRIVATE KEY-----').ok, false)
})

test('sanitizeId keeps safe ids and falls back', () => {
  assert.equal(sanitizeId('Work.A_1'), 'work.a_1')
  assert.equal(sanitizeId('../evil'), 'default')
  assert.equal(sanitizeId(''), 'default')
})

test('usage and render include percent header', () => {
  const entries = ['abc']
  const size = usage(entries, 10)
  assert.equal(size.used, 3)
  assert.equal(size.percent, 30)
  const block = renderBlock('标题', entries, 10)
  assert.match(block, /^## 标题 \[30% — 3\/10 字符\]/)
  assert.match(block, /- abc/)
})

test('totalChars accounts for separators', () => {
  assert.equal(totalChars(['ab', 'cd']), 4 + '\n§\n'.length)
})

test('a near-duplicate add rewrites the existing entry instead of stacking up', () => {
  const existing = ['项目一律用 pnpm，不生成 package-lock.json']
  const merged = applyOperation(existing, { action: 'add', content: '项目一律用 pnpm，不生成 package-lock.json 文件' })
  assert.equal(merged.ok, true)
  assert.equal(merged.entries.length, 1)
  assert.match(merged.entries[0], /pnpm/)
  assert.match(merged.mergedInto, /^[0-9a-f]{12}$/)

  const fresh = applyOperation(existing, { action: 'add', content: '打印机墨盒芯片读不到时换墨盒即可' })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.entries.length, 2)
  assert.equal(fresh.mergedInto, undefined)
})
test('per-persona writes are serialised, so no batch is lost', async () => {
  const order = []
  const run = (tag, delay) =>
    withPersonaLock('slot-x', async () => {
      order.push(`${tag}:start`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      order.push(`${tag}:end`)
    })
  await Promise.all([run('a', 20), run('b', 1)])
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'])
})
test('a nearly full tier refuses new entries but still accepts rewrites and removals', () => {
  const limit = 200
  const base = '项目约定一律用 pnpm 安装依赖并且不生成锁文件；'
  const full = [`${base.repeat(7)} ZETA`]
  assert.ok(full[0].length >= limit * 0.9)

  const diverted = applyOperations(full, [{ action: 'add', content: '打印机墨盒读不到时换一支即可' }], limit)
  assert.equal(diverted.ok, true)
  assert.equal(diverted.redirects.length, 1)
  assert.equal(diverted.entries.length, 1)

  const refused = applyOperations(full, [{ action: 'add', content: '再来一条' }], limit, { addOverflow: 'reject' })
  assert.equal(refused.ok, false)
  assert.equal(refused.blocked, 'threshold')

  const merged = applyOperations(full, [{ action: 'add', content: `${base.repeat(7)}。` }], limit)
  assert.equal(merged.ok, true)
  assert.equal(merged.entries.length, 1)

  const patched = applyOperations(full, [{ action: 'patch', old_text: 'ZETA', content: 'ZETA（严格）' }], limit)
  assert.equal(patched.ok, true)

  const removed = applyOperations(full, [{ action: 'remove', old_text: 'ZETA' }], limit)
  assert.equal(removed.ok, true)

  const disabled = applyOperations(full, [{ action: 'add', content: '再来一条' }], limit, { routeThreshold: 0 })
  assert.equal(disabled.ok, true)
})