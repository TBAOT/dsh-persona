import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { auditPersona, formatAudit } from '../lib/audit.js'
import { writeTopic, writeTopicManifest } from '../lib/topics.js'
import { refreshMeta, writeEntries } from '../lib/store.js'

async function withTempHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-persona-kit-audit-'))
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

const kinds = (report) => report.findings.map((item) => item.kind)

test('a healthy persona has no structural errors', async () => {
  await withTempHome(async () => {
    await writeEntries('clean', 'memory', ['项目用 pnpm 而不是 npm'])
    await writeEntries('clean', 'user', ['用户偏好简洁回答'])
    await writeTopic('clean', { slug: 'printer', summary: '打印机卡纸怎么处理', keywords: ['打印机'], content: '先查纸路再换鼓。' })
    await writeTopicManifest('clean')
    await refreshMeta('clean')
    const report = auditPersona('clean', { limits: { user: 1375, memory: 3000 } })
    assert.equal(report.errors, 0, formatAudit(report))
  })
})

test('duplicate facts are reported, inside a tier and across tiers', async () => {
  await withTempHome(async () => {
    await writeEntries('dupes', 'memory', ['项目一律用 pnpm 安装依赖', '项目一律用 pnpm 安装依赖'])
    await writeEntries('dupes', 'user', ['项目一律用 pnpm 安装依赖，不生成锁文件'])
    await refreshMeta('dupes')
    const report = auditPersona('dupes', { limits: { user: 1375, memory: 3000 } })
    assert.ok(kinds(report).includes('entry-duplicate'))
    assert.ok(kinds(report).includes('cross-tier-duplicate'))
    assert.ok(report.errors >= 2)
  })
})

test('an empty topic summary and near-duplicate topics are errors', async () => {
  await withTempHome(async () => {
    const dir = path.join(process.env.DSH_HOME, 'personas', 'topics', 'topics')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'blank.md'), '---\nslug: blank\nsummary:\nupdated: 2026-11-15\n---\n\n正文。\n', 'utf8')
    await writeFile(path.join(dir, 'a.md'), '---\nslug: a\nsummary: 打印机卡纸怎么处理\nupdated: 2026-11-15\n---\n\n先查纸路再换鼓。\n', 'utf8')
    await writeFile(path.join(dir, 'b.md'), '---\nslug: b\nsummary: 打印机卡纸怎么处理\nupdated: 2026-11-15\n---\n\n先查纸路再换鼓。\n', 'utf8')
    await writeEntries('topics', 'memory', ['项目用 pnpm'])
    await refreshMeta('topics')
    const report = auditPersona('topics', { limits: { user: 1375, memory: 3000 } })
    assert.ok(kinds(report).includes('topic-empty-summary'))
    assert.ok(kinds(report).includes('topic-near-duplicate'))
  })
})

test('a broken or contradictory policy is reported', async () => {
  await withTempHome(async () => {
    await writeEntries('pol', 'memory', ['项目用 pnpm'])
    await refreshMeta('pol')
    const dir = path.join(process.env.DSH_HOME, 'personas', 'pol', 'memory')
    await writeFile(path.join(dir, 'policy.json'), '{ nope', 'utf8')
    const broken = auditPersona('pol', { limits: { user: 1375, memory: 3000 } })
    assert.ok(kinds(broken).includes('policy-unreadable'))

    await writeFile(path.join(dir, 'policy.json'), JSON.stringify({ version: 1, limits: { memory: 1200 } }), 'utf8')
    const differing = auditPersona('pol', { limits: { user: 1375, memory: 3000 } })
    assert.ok(kinds(differing).includes('policy-limits-differ'))
  })
})

test('meta that no longer matches the files is reported as drift', async () => {
  await withTempHome(async () => {
    await writeEntries('drift', 'memory', ['第一条'])
    // no refreshMeta call: the file exists, the meta map does not
    const report = auditPersona('drift', { limits: { user: 1375, memory: 3000 } })
    assert.ok(kinds(report).includes('meta-drift'))
  })
})
