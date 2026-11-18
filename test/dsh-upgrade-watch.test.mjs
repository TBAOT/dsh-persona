import assert from 'node:assert/strict'
import test from 'node:test'
import { compareVersions } from '../scripts/check-dsh-upgrade.mjs'

test('prerelease ordering follows semver for DSH tags', () => {
  assert.ok(compareVersions('0.2.2-rc.1', '0.2.2-rc.3') < 0)
  assert.ok(compareVersions('0.2.2-rc.3', '0.2.2') < 0)
  assert.ok(compareVersions('0.2.2', '0.3.0') < 0)
  assert.ok(compareVersions('0.2.2-alpha.2', '0.2.2-rc.1') < 0)
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2-rc.1'), 0)
  assert.equal(compareVersions('dsh-v0.2.2-rc.2', '0.2.2-rc.2'), 0)
  assert.ok(compareVersions('0.2.1-rc.4', '0.2.2-rc.1') < 0)
})
