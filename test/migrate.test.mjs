import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { migratePersonaIds, orphanDirs } from '../lib/migrate.js'

async function withHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-migrate-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(path.join(home, 'personas'), { recursive: true })
    await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const writeIndex = (home, personas) =>
  writeFile(path.join(home, 'personas', 'index.json'), `${JSON.stringify({ version: 1, personas }, null, 2)}\n`, 'utf8')

test('slot ids are renamed to the persona name, data moving with them', async () => {
  await withHome(async (home) => {
    await mkdir(path.join(home, 'personas', 'slot-1', 'memory'), { recursive: true })
    await writeFile(path.join(home, 'personas', 'slot-1', 'memory', 'user.md'), 'hello', 'utf8')
    await writeIndex(home, [{ id: 'slot-1', name: '验证角色', workspaces: [] }])

    const result = migratePersonaIds()
    assert.deepEqual(result.renamed, [{ from: 'slot-1', to: '验证角色' }])

    const moved = await readFile(path.join(home, 'personas', '验证角色', 'memory', 'user.md'), 'utf8')
    assert.equal(moved, 'hello')
    const index = JSON.parse(await readFile(path.join(home, 'personas', 'index.json'), 'utf8'))
    assert.equal(index.personas[0].id, '验证角色')
    assert.equal(index.personas[0].presetId, 'persona-验证角色')
    assert.deepEqual(index.personas[0].previousIds, ['slot-1'])
  })
})

test('a taken name, a missing directory, and a name that cannot be a directory are skipped', async () => {
  await withHome(async (home) => {
    await mkdir(path.join(home, 'personas', 'slot-1'), { recursive: true })
    await mkdir(path.join(home, 'personas', 'slot-2'), { recursive: true })
    await mkdir(path.join(home, 'personas', 'slot-3'), { recursive: true })
    await writeIndex(home, [
      { id: '已有', name: '别的角色', workspaces: [] },
      { id: 'slot-1', name: '已有', workspaces: [] },
      { id: 'slot-2', name: '', workspaces: [] },
      { id: 'slot-3', name: '新的', workspaces: [] },
    ])

    const result = migratePersonaIds()
    const reasons = result.skipped.map((item) => item.reason).join(' | ')
    assert.match(reasons, /已被占用/)
    assert.match(reasons, /不能作为目录名/)
    assert.deepEqual(result.renamed, [{ from: 'slot-3', to: '新的' }])
  })
})

test('the migration is a no-op the second time', async () => {
  await withHome(async (home) => {
    await mkdir(path.join(home, 'personas', '验证角色'), { recursive: true })
    await writeIndex(home, [{ id: '验证角色', name: '验证角色', workspaces: [] }])
    const result = migratePersonaIds()
    assert.equal(result.changed, false)
    assert.deepEqual(result.renamed, [])
  })
})

test('a directory without an index entry is reported as an orphan', async () => {
  await withHome(async (home) => {
    await mkdir(path.join(home, 'personas', '孤儿'), { recursive: true })
    await writeIndex(home, [{ id: 'known', name: 'known', workspaces: [] }])
    assert.deepEqual(orphanDirs(), ['孤儿'])
  })
})
