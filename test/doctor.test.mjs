import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkDependencies, dshVersionOf, inspectProfile, parsePatch, validateEntries } from '../lib/doctor.js'

test('a well-formed patch has no problems', () => {
  const problems = validateEntries([
    { id: 'ui-settings-account', name: '@deepseek-ai/dsh-client-ui-settings-account', config: { step: 'done' } },
    { insert: [{ id: 'persona-memory', name: 'dsh-persona-kit', config: {} }] },
  ])
  assert.deepEqual(problems, [])
})

test('the rc.3 loader rules are reported with a location', () => {
  const problems = validateEntries([
    { name: 42 },
    { name: 'x', group: 'true' },
    { name: 'y', group: true },
    { name: 'z', inject: 'nope' },
    { name: 'w', isolate: [] },
    { name: 'v', isolate: { db: 1 } },
    'not-an-entry',
  ])
  const text = problems.map((item) => `${item.where}: ${item.message}`).join('\n')
  assert.match(text, /name 必须是字符串/)
  assert.match(text, /group 必须是布尔值/)
  assert.match(text, /group: true 必须带 config/)
  assert.match(text, /inject 必须是字符串列表或映射/)
  assert.match(text, /isolate 必须是映射/)
  assert.match(text, /isolate 的值必须是 true 或字符串/)
  assert.match(text, /条目必须是映射/)
})

test('group children are checked too', () => {
  const problems = validateEntries([{ name: 'g', group: true, config: [{ name: 1 }] }])
  assert.equal(problems.length, 1)
  assert.match(problems[0].where, /config\[0\]/)
})

test('!!js expressions are accepted, and a broken file is reported not thrown', () => {
  const parsed = parsePatch('"this is not a list"')
  assert.equal(parsed.ok, false)

  const withJs = parsePatch('- name: x\n  disabled: !!js process.env.NO_X\n')
  assert.equal(withJs.ok, true)
  assert.deepEqual(validateEntries(withJs.entries), [])
})

test('link dependencies must exist and be installed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-'))
  try {
    const target = path.join(dir, 'plugin')
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'package.json'), '{"name":"p"}', 'utf8')
    const profileDir = path.join(dir, 'profile')
    await mkdir(path.join(profileDir, 'node_modules', 'p'), { recursive: true })
    await writeFile(path.join(profileDir, 'node_modules', 'p', 'package.json'), '{"name":"p"}', 'utf8')

    const pkg = { dependencies: { p: `link:${target}`, missing: `link:${path.join(dir, 'nope')}` } }
    const problems = checkDependencies(pkg, profileDir).map((item) => item.where)
    assert.deepEqual(problems, ['missing'])
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('the DSH version comes from the core dependency', () => {
  assert.equal(dshVersionOf({ dependencies: { '@deepseek-ai/dsh-experimental-session-search': '0.2.2-rc.5' } }), '0.2.2-rc.5')
  assert.equal(dshVersionOf({ dependencies: {} }), null)
})

test('inspectProfile ties the checks together', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-doctor-'))
  try {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } }, dependencies: { '@deepseek-ai/dsh-base': '0.2.2-rc.5' } }),
      'utf8',
    )
    await writeFile(path.join(dir, 'cordis.patch.yml'), '- name: ok\n', 'utf8')
    const result = inspectProfile(dir)
    assert.deepEqual(result.problems, [])
    assert.equal(result.dshVersion, '0.2.2-rc.5')
    assert.equal(result.entries.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
