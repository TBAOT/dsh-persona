import assert from 'node:assert/strict'
import test from 'node:test'
import { outcomeOf, summarizeMetrics } from '../lib/health.js'

const today = new Date('2026-11-15T12:00:00+08:00')
const at = '2026-11-15T11:00:00+08:00'

const row = (overrides = {}) => ({ at, turn: 1, status: 'written', ...overrides })

test('an injected window is healthy and adds the tokens up', () => {
  const summary = summarizeMetrics(
    [
      row({ recall: { outcome: 'injected', chars: 171 }, tokens: { in: 2602, out: 441 } }),
      row({ recall: { outcome: 'no-match', chars: 0 }, tokens: { in: 100, out: 10 } }),
    ],
    { today },
  )
  assert.equal(summary.verdict, 'ok')
  assert.equal(summary.injected, 1)
  assert.deepEqual(summary.tokens, { in: 2702, out: 451 })
  assert.equal(summary.tokenWarning, false)
})

test('a shape failure is reported as broken, not as zero', () => {
  const summary = summarizeMetrics([row({ recall: { outcome: 'unmatched-shape', chars: 0 } })], { today })
  assert.equal(summary.verdict, 'broken')
})

test('a window that should have injected but never did is silent', () => {
  const summary = summarizeMetrics(
    [row({ recall: { outcome: 'no-match', chars: 0 } }), row({ recall: { outcome: 'no-topics', chars: 0 } })],
    { today },
  )
  assert.equal(summary.verdict, 'silent')
  assert.equal(summary.injected, 0)
})

test('rows that cannot be attributed to a turn are unverified, not silent', () => {
  const summary = summarizeMetrics(
    [row({ recall: { outcome: 'unknown', chars: 0 } }), row({ recall: { outcome: 'unknown', chars: 0 } })],
    { today },
  )
  assert.equal(summary.verdict, 'unverified')
  assert.equal(summary.injected, 0)
})

test('trivial turns alone are not an alarm', () => {
  const summary = summarizeMetrics([row({ recall: { outcome: 'trivial', chars: 0 }, status: 'skipped' })], { today })
  assert.equal(summary.verdict, 'ok')
})

test('old rows are stale, and all-missing usage is flagged', () => {
  const stale = summarizeMetrics([{ ...row(), at: '2026-10-01T10:00:00+08:00' }], { today })
  assert.equal(stale.verdict, 'stale')

  const missing = summarizeMetrics([row({ recall: { outcome: 'injected', chars: 10 }, usageMissing: true })], { today })
  assert.equal(missing.tokenWarning, true)
})

test('legacy rows without a recall object still count as injected when they carry a size', () => {
  assert.equal(outcomeOf({ recallChars: 60 }), 'injected')
  assert.equal(outcomeOf({ recallChars: 0 }), 'unknown')
  const summary = summarizeMetrics([row({ recallChars: 60 })], { today })
  assert.equal(summary.verdict, 'ok')
})
