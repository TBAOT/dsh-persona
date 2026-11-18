import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { moveToTrash } from '../lib/trash.js'

async function withHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-trash-'))
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

test('deleting a persona moves its memory into the trash, recoverable', async () => {
  await withHome(async (home) => {
    const dir = path.join(home, 'personas', '甲')
    await mkdir(path.join(dir, 'memory'), { recursive: true })
    await writeFile(path.join(dir, 'memory', 'user.md'), '画像内容', 'utf8')

    const moved = moveToTrash(dir, { kind: 'persona', id: '甲' })
    assert.equal(moved.moved, true)
    assert.equal(existsSync(dir), false, '原目录必须消失，否则又变成孤儿')
    assert.equal(await readFile(path.join(moved.to, 'memory', 'user.md'), 'utf8'), '画像内容')
    assert.match(moved.to, /trash/)
  })
})

test('a second delete with the same name does not overwrite the first copy', async () => {
  await withHome(async (home) => {
    const first = path.join(home, 'personas', '甲')
    await mkdir(first, { recursive: true })
    await writeFile(path.join(first, 'marker.txt'), 'one', 'utf8')
    const movedFirst = moveToTrash(first, { kind: 'persona', id: '甲' })

    await mkdir(first, { recursive: true })
    await writeFile(path.join(first, 'marker.txt'), 'two', 'utf8')
    const movedSecond = moveToTrash(first, { kind: 'persona', id: '甲' })

    assert.notEqual(movedFirst.to, movedSecond.to)
    assert.equal(await readFile(path.join(movedFirst.to, 'marker.txt'), 'utf8'), 'one')
    assert.equal(await readFile(path.join(movedSecond.to, 'marker.txt'), 'utf8'), 'two')
  })
})

test('a missing directory is reported instead of throwing', async () => {
  await withHome(async (home) => {
    const moved = moveToTrash(path.join(home, 'personas', '没有'), { kind: 'persona', id: '没有' })
    assert.equal(moved.moved, false)
    assert.equal(moved.reason, 'source-missing')
  })
})
