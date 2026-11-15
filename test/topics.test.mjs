import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { mkdir } from 'node:fs/promises'
import {
  TOPIC_MAX_CHARS,
  archiveTopic,
  deriveSummary,
  isTopicExpired,
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
    assert.match(text, /alpha｜甲/)
    assert.match(text, /beta｜乙/)

    const tight = renderTopicIndex(topics, 40)
    assert.match(tight, /未列出|alpha|beta/)
  })
})

test('a topic written without a summary derives one from its first sentence', async () => {
  await withTempHome(async () => {
    const written = await writeTopic('slot-1', {
      slug: 'no-summary',
      content: '## 2026-11-14\n\n转存路径丢了摘要，索引行只剩 slug。后面这句不该进摘要。',
    })
    assert.equal(written.ok, true)
    const topic = listTopicsSync('slot-1').find((item) => item.slug === 'no-summary')
    assert.match(topic.summary, /转存路径丢了摘要/)
    assert.ok(!topic.summary.includes('后面这句'))
    assert.ok(topic.summary.length <= 30)

    await writeTopic('slot-1', { slug: 'explicit', summary: '显式摘要', content: '正文随便写。' })
    assert.equal(listTopicsSync('slot-1').find((item) => item.slug === 'explicit').summary, '显式摘要')
    assert.equal(deriveSummary(''), '')
  })
})

test('retrieval aliases survive a rewrite and stay out of the index line', async () => {
  await withTempHome(async () => {
    await writeTopic('slot-1', {
      slug: 'permission',
      summary: 'ACL 备份与回滚',
      keywords: '权限备份，文件夹，能不能删',
      content: '第一段。',
    })
    const first = listTopicsSync('slot-1').find((topic) => topic.slug === 'permission')
    assert.deepEqual(first.keywords, ['权限备份', '文件夹', '能不能删'])

    // Appending more detail must not drop the aliases set earlier.
    await writeTopic('slot-1', { slug: 'permission', content: '第二段。' })
    assert.deepEqual(listTopicsSync('slot-1').find((topic) => topic.slug === 'permission').keywords, ['权限备份', '文件夹', '能不能删'])

    const index = renderTopicIndex(listTopicsSync('slot-1'), 500)
    assert.match(index, /permission｜ACL/)
    assert.ok(!index.includes('能不能删'), '别名只参与打分，不占索引字符')
  })
})

test('a slugless write reuses the topic it is about instead of minting a new one', async () => {
  await withTempHome(async () => {
    await writeTopic('slot-1', {
      slug: '权限修复',
      summary: 'ACL 留档与回滚',
      content: 'acl-recovery 目录里有三份备份、回滚脚本与报告，权限修复时按它回滚。',
    })
    // Overflowing entries arrive without a slug; they must extend the subject that
    // already exists instead of creating one topic per turn.
    const again = await writeTopic('slot-1', {
      content: 'acl-recovery 目录里的回滚脚本与报告要留档，权限修复回滚时按这三份来。',
    })
    assert.equal(again.ok, true)
    assert.equal(again.slug, '权限修复')
    assert.equal(listTopicsSync('slot-1').length, 1)

    const unrelated = await writeTopic('slot-1', { content: '打印机墨盒芯片读不到时换一支新的即可。' })
    assert.notEqual(unrelated.slug, '权限修复')
    assert.equal(listTopicsSync('slot-1').length, 2)
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

test('a topic that stopped changing expires, and archiving retires it without deleting', async () => {
  const old = { slug: 'old', summary: '旧', updated: '2026-01-01' }
  const fresh = { slug: 'new', summary: '新', updated: '2026-11-14' }
  assert.equal(isTopicExpired(old, 90, '2026-11-14'), true)
  assert.equal(isTopicExpired(fresh, 90, '2026-11-14'), false)
  assert.equal(isTopicExpired(old, 0, '2026-11-14'), false, 'ttlDays=0 关闭过期')

  await withTempHome(async () => {
    await writeTopic('slot-1', { slug: 'dead', summary: '要归档的', content: '正文一条' })
    const archived = await archiveTopic('slot-1', 'dead')
    assert.equal(archived.ok, true)
    assert.equal(listTopicsSync('slot-1').length, 0)
    const kept = await readFile(archived.archived, 'utf8')
    assert.match(kept, /正文一条/)
  })
})