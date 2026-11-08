/**
 * Topic-recall probe.
 *
 * Measures one narrow thing: given a question a human would actually type, does
 * keyword scoring land on the topic file that holds the answer? It does not
 * measure whether the model then reads that file — that is observed in real
 * sessions, not simulated here.
 *
 *   node scripts/probe.mjs                 # all personas with topics
 *   node scripts/probe.mjs --persona slot-1
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { listTopicsSync } from '../lib/topics.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const personaArg = process.argv.find((arg) => arg.startsWith('--persona='))?.split('=')[1]

/** Question and document are compared as token sets; CJK uses 2-grams. */
export function tokens(text) {
  const set = new Set()
  for (const word of String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)) {
    if (/^[a-z0-9]+$/.test(word)) {
      set.add(word)
      continue
    }
    if (word.length <= 2) set.add(word)
    else for (let index = 0; index < word.length - 1; index += 1) set.add(word.slice(index, index + 2))
  }
  return set
}

export function score(query, topic) {
  const q = tokens(query)
  const doc = tokens(`${topic.slug} ${topic.summary} ${topic.body}`)
  if (!q.size || !doc.size) return 0
  let shared = 0
  for (const token of q) if (doc.has(token)) shared += 1
  // Coverage of the question, tempered by how much of the document it touches.
  return (shared / q.size) * 0.75 + (shared / doc.size) * 0.25
}

export function rank(query, topics) {
  return topics
    .map((topic) => ({ slug: topic.slug, score: Number(score(query, topic).toFixed(3)) }))
    .sort((left, right) => right.score - left.score)
}

const questions = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'test', 'probe', 'questions.json'), 'utf8')).questions
const personas = personaArg
  ? [personaArg]
  : ['slot-1', 'slot-2', 'default'].filter((id) => listTopicsSync(id).length)

let asked = 0
let hit = 0
const misses = []

for (const persona of personas) {
  const topics = listTopicsSync(persona)
  if (!topics.length) continue
  console.log(`\n== ${persona}（${topics.length} 个主题）==`)
  for (const item of questions) {
    const ranked = rank(item.q, topics)
    const top = ranked[0]
    const ok = item.expect === null ? !top || top.score < 0.35 : top?.slug === item.expect
    asked += 1
    if (ok) hit += 1
    else misses.push({ persona, q: item.q, expect: item.expect, got: top?.slug ?? '(无)', score: top?.score ?? 0 })
    const mark = ok ? '✓' : '✗'
    console.log(`  ${mark} ${item.q}  →  ${top?.slug ?? '(无)'} ${top?.score ?? 0}${item.expect ? `（期望 ${item.expect}）` : '（负例）'}`)
  }
}

console.log(`\n命中 ${hit}/${asked}（${asked ? Math.round((hit / asked) * 100) : 0}%）`)
if (misses.length) {
  console.log('未命中清单：')
  for (const miss of misses) console.log(`  - [${miss.persona}] ${miss.q}：期望 ${miss.expect ?? '(空)'}，实际 ${miss.got}（${miss.score}）`)
}
console.log('\n注意：这里只测「关键词打分能否定位到主题文件」，不代替真实会话里模型是否去读。')
process.exit(hit === asked ? 0 : 1)
