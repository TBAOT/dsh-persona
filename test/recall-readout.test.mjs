import assert from 'node:assert/strict'
import test from 'node:test'
import { recallReadout } from '../lib/client/recall-readout.js'

const last = (recall) => ({ at: '2026-11-15T10:20:00+08:00', turn: 12, recall, tokens: { in: 10, out: 2 } })

test('an injected turn reads as topics and characters', () => {
  const view = recallReadout({ verdict: 'ok', window: 5, injected: 3, last: last({ outcome: 'injected', chars: 171, topics: ['磁盘与清理'], ms: 3.7 }) })
  assert.equal(view.label, '召回 1 篇 / 171 字符')
  assert.equal(view.tone, undefined)
  assert.match(view.title, /turn 12/)
  assert.match(view.title, /已注入/)
  assert.match(view.title, /磁盘与清理/)
})

test('a turn without injection says so without alarm', () => {
  const view = recallReadout({ verdict: 'ok', window: 5, injected: 0, last: last({ outcome: 'no-match', chars: 0, topics: [], ms: 2 }) })
  assert.equal(view.label, '召回 —')
  assert.equal(view.tone, undefined)
  assert.match(view.title, /本轮无命中/)
})

test('only broken or silent turns carry the warn tone', () => {
  assert.equal(recallReadout({ verdict: 'broken', window: 5, injected: 0, last: last({ outcome: 'error', chars: 0 }) }).tone, 'warn')
  assert.equal(recallReadout({ verdict: 'silent', window: 5, injected: 0, last: last({ outcome: 'unknown', chars: 0 }) }).tone, 'warn')
  assert.equal(recallReadout({ verdict: 'unverified', window: 5, injected: 0, last: last({ outcome: 'unknown', chars: 0 }) }).tone, undefined)
})

test('an unknown outcome is spelled out instead of shown raw', () => {
  const view = recallReadout({ verdict: 'ok', window: 5, injected: 1, last: last({ outcome: 'unmatched-shape', chars: 0 }) })
  assert.match(view.title, /注入形状不符/)
  assert.equal(recallReadout(null).label, '')
})
