import assert from 'node:assert/strict'
import test from 'node:test'
import { nextVersion, readFlags } from '../scripts/release.mjs'

test('version bumps stay aligned between tag and package.json', () => {
  assert.equal(nextVersion('0.13.2', 'patch'), '0.13.3')
  assert.equal(nextVersion('0.13.2', 'minor'), '0.14.0')
  assert.equal(nextVersion('0.13.2', 'major'), '1.0.0')
  assert.equal(nextVersion('0.13.2', '0.20.1'), '0.20.1')
  assert.throws(() => nextVersion('0.13.2', 'huge'), /不认识的版本参数/)
})

test('flags are read without swallowing the next flag', () => {
  const flags = readFlags(['patch', '--title', '0.13.3：修 x', '--dry-run'])
  assert.equal(flags.bump, 'patch')
  assert.equal(flags.title, '0.13.3：修 x')
  assert.equal(flags.dryRun, true)
  assert.equal(flags.noPush, false)
})
