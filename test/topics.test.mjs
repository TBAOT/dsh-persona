import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { mkdir } from 'node:fs/promises'
import {
  TOPIC_MAX_CHARS,
  listTopicsSync,
  overlap,
  readTopic,
  renderTopicIndex,
  slugify,
  writeTopic,
  writeTopicManifest,
} from '../lib/topics.js'

async function withTempHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-topics-'))
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

test('slug keeps ascii kebab and chinese, derives everything else', () => {
  assert.equal(slugify('printer-fix'), 'printer-fix')
  assert.equal(slugify('打印机'), '打印机')
  assert.equal(slugify('Printer Fix!'), 'printer-fix')
  assert.equal(slugify('   '), 'untitled')
  assert.ok(slugify('WeChat Data Analysis').length <= 41)
})

test('a topic file carries front matter and appends instead of overwriting', async () => {
  await withTempHome(async () => {
    const first = await writeTopic('slot-1', { slug: 'printer', summary: '打印机排查', content: '现象：队列为空' })
    assert.equal(first.ok, true)
    assert.equal(first.created, true)

    const second = await writeTopic('slot-1', { slug: 'printer', content: '结论：换墨盒' })
    assert.equal(second.ok, true)
    const topic = readTopic(first.path)
    assert.equal(topic.summary, '打印机排查')
    assert.match(topic.body, /现象：队列为空/)
    assert.match(topic.body, /结论：换墨盒/)

    const duplicate = await writeTopic('slot-1', { slug: 'printer', content: '结论：换墨盒' })
    assert.equal(duplicate.skipped, true)
  })
})

test('a topic refuses to grow past its cap', async () => {
  await withTempHome(async () => {
    const result = await writeTopic('slot-1', { slug: 'big', content: 'x'.repeat(TOPIC_MAX_CHARS) })
    assert.equal(result.ok, false)
    assert.match(result.error, /已满/)
  })
})

test('the prompt index lists slug, summary and path within budget', async () => {
  await withTempHome(async () => {
    await writeTopic('slot-1', { slug: 'alpha', summary: '甲', content: 'a' })
    await writeTopic('slot-1', { slug: 'beta', summary: '乙', content: 'b' })
    const topics = listTopicsSync('slot-1')
    assert.equal(topics.length, 2)
    const text = renderTopicIndex(topics, 500)
    assert.match(text, /alpha｜甲｜/)
    assert.match(text, /beta｜乙｜/)

    const tight = renderTopicIndex(topics, 40)
    assert.match(tight, /未列出|alpha|beta/)
  })
})

test('overlap spots near-duplicate subjects', () => {
  assert.ok(overlap('打印机队列为空，需要重建', '打印机队列是空的，需要重建队列') > 0.5)
  assert.ok(overlap('打印机', '数据库迁移') < 0.3)
})

test('rebuilding the manifest reads the topic files', async () => {
  await withTempHome(async (home) => {
    await writeTopic('slot-1', { slug: 'one', summary: '一', content: 'x'.repeat(20) })
    const result = await writeTopicManifest('slot-1')
    assert.equal(result.count, 1)
    const manifest = JSON.parse(await readFile(path.join(home, 'personas', 'slot-1', 'memory', 'index', 'manifest.json'), 'utf8'))
    assert.equal(manifest.topics[0].slug, 'one')
  })
})
