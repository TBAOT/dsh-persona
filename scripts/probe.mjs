/**
 * Topic-recall probe.
 *
 * Measures one narrow thing: given a question a human actually typed, does the
 * live scorer put the answering topic at rank 1? It does not measure whether the
 * model then opens the file — that is observed in real sessions.
 *
 * The scoring is imported from lib/recall.js, so "what the probe reports" and
 * "what the turn actually does" cannot drift apart; the earlier copy-in-place
 * scorer is why the probe could stay green while the live path was dead.
 *
 * Three numbers are always reported together, because any single one is easy to
 * game: hit rate, injected characters (the prompt cost of the block) and scoring
 * latency.
 *
 *   node scripts/probe.mjs                          # every persona with topics
 *   node scripts/probe.mjs --persona=slot-1
 *   node scripts/probe.mjs --persona=slot-1 --split=verify
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listTopicsSync } from '../lib/topics.js'
import { rankTopics, selectTopics } from '../lib/recall.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split('=')[1]
const personaArg = arg('persona')
const split = arg('split') ?? 'all'
const budget = Number(arg('budget') ?? 400)
const topN = Number(arg('topN') ?? 3)

const file = path.join(import.meta.dirname, '..', 'test', 'probe', 'questions.json')
const suite = JSON.parse(readFileSync(file, 'utf8'))
const threshold = Number(suite.threshold ?? 0.35)

const questions = suite.questions.filter((item) =>
  split === 'tune' ? !item.holdout : split === 'verify' ? item.holdout : true,
)
if (!questions.length) {
  console.error(`没有符合 --split=${split} 的题目`)
  process.exit(1)
}

const personas = personaArg ? [personaArg] : ['slot-1', 'slot-2', 'slot-3', 'default'].filter((id) => listTopicsSync(id).length)
const types = ['single-hop', 'multi-hop', 'temporal', 'negative']

/** One question against one persona's library. */
export function judge(question, topics) {
  const startedAt = performance.now()
  const ranked = rankTopics(question.q, topics, topN)
  const picked = selectTopics(question.q, topics, { topN, budget })
  const ms = performance.now() - startedAt
  const top = ranked[0]
  const topSlug = top?.topic?.slug ?? '(无)'
  const expected = question.expect
  const ok = expected === null || expected === undefined
    ? !top || top.score < threshold
    : Array.isArray(expected)
      ? Boolean(top && expected.includes(topSlug))
      : topSlug === expected
  return {
    ok,
    ms,
    chars: picked.block.length,
    got: topSlug,
    score: top?.score ?? 0,
    expected,
    reason: !ok && (expected === null || expected === undefined) ? '误召回' : '未命中',
  }
}

const rows = []
for (const persona of personas) {
  const topics = listTopicsSync(persona)
  if (!topics.length) continue
  console.log(`\n== ${persona}（${topics.length} 个主题）==`)
  for (const question of questions) {
    const result = judge(question, topics)
    rows.push({ persona, ...question, ...result })
    const mark = result.ok ? '✓' : '✗'
    const expectText = Array.isArray(result.expected) ? result.expected.join('|') : (result.expected ?? '(负例)')
    console.log(
      `  ${mark} [${question.type}] ${question.q}\n      → ${result.got} ${result.score}（期望 ${expectText}，注入 ${result.chars} 字符）`,
    )
  }
}

const width = 12
const pad = (text, size = width) => String(text).padEnd(size)
const padStart = (text, size = width) => String(text).padStart(size)

console.log(`\n== 汇总（split=${split}，threshold=${threshold}）==`)
console.log(`  ${pad('题型')}${padStart('题数', 6)}${padStart('命中', 6)}${padStart('命中率', 8)}${padStart('注入字符', 10)}${padStart('耗时', 9)}`)
let total = 0
let hits = 0
let chars = 0
let ms = 0
for (const type of types) {
  const bucket = rows.filter((row) => row.type === type)
  if (!bucket.length) continue
  const hit = bucket.filter((row) => row.ok).length
  const charsAvg = Math.round(bucket.reduce((sum, row) => sum + row.chars, 0) / bucket.length)
  const msAvg = bucket.reduce((sum, row) => sum + row.ms, 0) / bucket.length
  total += bucket.length
  hits += hit
  chars += bucket.reduce((sum, row) => sum + row.chars, 0)
  ms += bucket.reduce((sum, row) => sum + row.ms, 0)
  console.log(
    `  ${pad(type)}${padStart(bucket.length, 6)}${padStart(hit, 6)}${padStart(`${Math.round((hit / bucket.length) * 100)}%`, 8)}${padStart(charsAvg, 10)}${padStart(`${msAvg.toFixed(2)}ms`, 9)}`,
  )
}
const rate = total ? Math.round((hits / total) * 100) : 0
console.log(
  `  ${pad('合计')}${padStart(total, 6)}${padStart(hits, 6)}${padStart(`${rate}%`, 8)}${padStart(Math.round(chars / total), 10)}${padStart(`${(ms / total).toFixed(2)}ms`, 9)}`,
)
console.log(`\n三数同报：命中率 ${rate}%（${hits}/${total}）｜平均注入 ${Math.round(chars / total)} 字符｜平均耗时 ${(ms / total).toFixed(2)}ms`)

const misses = rows.filter((row) => !row.ok)
if (misses.length) {
  console.log('\n未通过清单：')
  for (const miss of misses) {
    const expected = Array.isArray(miss.expected) ? miss.expected.join('|') : (miss.expected ?? '(负例)')
    console.log(`  - [${miss.persona}/${miss.type}] ${miss.q}：期望 ${expected}，实际 ${miss.got}（${miss.score}）${miss.reason === '误召回' ? '← 负例被误召回' : ''}`)
  }
}

const negativeLeak = rows.some((row) => row.type === 'negative' && !row.ok)
const verifyGate = split === 'verify' ? rate >= 70 : true
if (negativeLeak) console.log('\n失败：负例题被误召回，说明阈值/打分把无关问题也召回了。')
if (split === 'verify' && !verifyGate) console.log(`\n失败：留出集命中率 ${rate}% 低于 70%，不能作为验收通过。`)
console.log('\n注意：这里只测「打分能否把对的主题排到第一」，不代替真实会话里模型是否去读文件；注入字符即该块的提示词成本。')
process.exit(negativeLeak || !verifyGate ? 1 : 0)
