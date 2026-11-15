import assert from 'node:assert/strict'
import test from 'node:test'

import { injectRecall, isTrivialPrompt, noteRecall, rankTopics, recallSummary, resetRecall, buildRecallBlock, selectTopics } from '../lib/recall.js'

const topics = [
  { slug: 'github-token', summary: '换 GitHub token 的三步与导入脚本', body: 'token 存在 keyring，代理不通时走 REST API。' },
  { slug: '磁盘与清理', summary: '清理脚本、会话归档判据与运行时位置', body: 'clean-dsh.ps1 清 %TEMP%，dsh-runtimes 不动。' },
  { slug: '权限修复', summary: 'ACL 备份与回滚：权限修复留下的三份留档', body: 'acl-recovery 目录里有 backup、脚本和报告。' },
]

test('recall ranks the topic that actually answers the question', () => {
  assert.equal(rankTopics('清理脚本都清哪些目录', topics)[0].topic.slug, '磁盘与清理')
  assert.equal(rankTopics('那个权限备份的文件夹能删吗', topics)[0].topic.slug, '权限修复')
  assert.equal(rankTopics('Kubernetes sidecar 怎么写', topics).length, 0)
})

test('recall skips trivial prompts and empty matches', () => {
  assert.equal(isTrivialPrompt('嗯'), true)
  assert.equal(isTrivialPrompt('/clear'), true)
  assert.equal(isTrivialPrompt('清理脚本都清哪些目录'), false)
  assert.equal(buildRecallBlock('嗯', topics), '')
  assert.equal(buildRecallBlock('Kubernetes sidecar 怎么写', topics), '')
})

test('the recall block respects its budget and keeps the header', () => {
  const block = buildRecallBlock('清理脚本都清哪些目录', topics, { topN: 3, budget: 400 })
  assert.match(block, /^可能相关的主题/)
  assert.match(block, /磁盘与清理/)
  const tight = buildRecallBlock('清理脚本都清哪些目录 token 权限', topics, { topN: 3, budget: 40 })
  assert.equal(tight, '')
  assert.equal(buildRecallBlock('清理脚本都清哪些目录', topics, { topN: 0 }), '')
})

test('aliases let a paraphrase reach the topic its summary would miss', () => {
  const library = [
    {
      slug: '权限修复',
      summary: 'ACL 备份与回滚：三份留档',
      keywords: ['那个权限备份的文件夹', '能不能删'],
      body: 'acl-recovery 目录里有 backup 与报告。',
    },
    { slug: 'plan-062-to-080', summary: '止血与召回方案', keywords: [], body: '阶段一压缩常驻。' },
  ]
  const query = '上次那个权限备份的文件夹现在能删吗'
  assert.equal(rankTopics(query, library)[0].topic.slug, '权限修复')
  // Without aliases the same query has to survive on the summary alone.
  const withoutAliases = library.map((topic) => ({ ...topic, keywords: [] }))
  const bare = rankTopics(query, withoutAliases)[0]
  assert.ok(bare.score <= rankTopics(query, library)[0].score)
})

test('selectTopics says why it produced nothing', () => {
  assert.equal(selectTopics('嗯', topics).reason, 'trivial')
  assert.equal(selectTopics('Kubernetes sidecar 怎么写', topics).reason, 'no-match')
  assert.equal(selectTopics('清理脚本都清哪些目录', topics, { topN: 0 }).reason, 'disabled')
  assert.equal(selectTopics('清理脚本都清哪些目录', topics, { budget: 10 }).reason, 'over-budget')
  const picked = selectTopics('清理脚本都清哪些目录', topics)
  assert.equal(picked.reason, 'matched')
  assert.equal(picked.picks[0], '磁盘与清理')
})

test('a later step in the same turn does not overwrite the injection', () => {
  resetRecall()
  noteRecall({ outcome: 'injected', chars: 171, topics: ['磁盘与清理'], ms: 4, turn: 9 })
  // Step 2 of the same turn correctly skips; it must not turn the turn's record into
  // `skipped`, which is what live metrics showed right after 0.10.x shipped.
  noteRecall({ outcome: 'skipped', chars: 0, topics: [], ms: 5, turn: 9 })
  const record = recallSummary(9)
  assert.equal(record.outcome, 'injected')
  assert.equal(record.chars, 171)
  resetRecall()
})

test('injectRecall appends to the last user message and leaves the input alone', () => {
  const messages = [
    { role: 'assistant', content: 'a' },
    { role: 'user', content: '问题' },
  ]
  const result = injectRecall(messages, 'RECALL')
  assert.equal(result.injected, true)
  assert.equal(result.chars, 6)
  assert.equal(result.messages[1].content, '问题\n\nRECALL')
  // The Host marks messages readonly; we must not rely on mutating them.
  assert.equal(messages[1].content, '问题')
  assert.equal(result.messages[0], messages[0])

  const blocks = [{ role: 'user', content: [{ type: 'text', text: '问题' }] }]
  const second = injectRecall(blocks, 'RECALL')
  assert.equal(second.injected, true)
  assert.deepEqual(second.messages[0].content.at(-1), { type: 'text', text: 'RECALL' })

  assert.equal(injectRecall([], 'RECALL').injected, false)
  assert.equal(injectRecall([{ role: 'assistant', content: 'a' }], 'RECALL').injected, false)
  assert.equal(injectRecall(second.messages, 'RECALL').injected, false, '同一个块不会叠加两次')
})
