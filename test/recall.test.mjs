import assert from 'node:assert/strict'
import test from 'node:test'

import { applyRecall, buildRecallBlock, isTrivialPrompt, rankTopics } from '../lib/recall.js'

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

test('applyRecall appends to the last user message in every supported shape', () => {
  const plain = { messages: [{ role: 'user', content: '问题' }] }
  assert.equal(applyRecall(plain, 'RECALL'), true)
  assert.equal(plain.messages[0].content, '问题\n\nRECALL')

  const blocks = { messages: [{ role: 'assistant', content: 'a' }, { role: 'user', content: [{ type: 'text', text: '问题' }] }] }
  assert.equal(applyRecall(blocks, 'RECALL'), true)
  assert.deepEqual(blocks.messages[1].content.at(-1), { type: 'text', text: 'RECALL' })

  assert.equal(applyRecall({}, 'RECALL'), false)
  assert.equal(applyRecall({ messages: [{ role: 'assistant', content: 'a' }] }, 'RECALL'), false)
})
