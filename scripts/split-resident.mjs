/**
 * Split resident entries into "one fact, ≤120 chars" index lines plus topic bodies.
 *
 * The resident tier is what always enters the prompt; prose belongs in the topic
 * library. This moves the prose, keeps one sentence per fact, and is safe to run
 * twice (anything already short enough is left alone). Bodies go to an existing
 * topic when the keywords match, otherwise to `<persona>-细节`.
 *
 *   node scripts/split-resident.mjs --persona=slot-1              # dry-run, prints the plan
 *   node scripts/split-resident.mjs --persona=slot-1 --apply      # backup, then write
 *   node scripts/split-resident.mjs --apply --persona=slot-2 --persona=slot-3
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ENTRY_MAX_CHARS, readMetaSync, refreshMeta, readEntriesSync, writeEntries } from '../lib/store.js'
import { autoSlug, listTopicsSync, writeTopic, writeTopicManifest } from '../lib/topics.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const personas = args.filter((item) => item.startsWith('--persona=')).map((item) => item.split('=')[1])
const targets = args.filter((item) => item.startsWith('--target=')).map((item) => item.split('=')[1])
const wantedTargets = targets.length ? targets : ['memory', 'user']
const list = personas.length ? personas : ['slot-1']

/**
 * Keyword → existing topic. Deliberately narrow: a generic word like "权限" matched
 * the wrong topic in the first dry-run, so each route uses a phrase that only
 * appears when the entry really is about that subject.
 */
const ROUTES = [
  { match: ['ACL', 'acl-recovery'], slug: '权限修复' },
  { match: ['prefetch', 'Hermes'], slug: 'hermes-memory-arch' },
  { match: ['probe', 'holdout', 'tune'], slug: 'memory-eval' },
  { match: ['TTL', '失效链', 'expiresAt'], slug: 'forgetting-ttl-research' },
  { match: ['tag v', 'push', 'CI'], slug: 'release-and-install' },
  { match: ['技术方案', 'plan_doc'], slug: '记忆方案文档' },
  { match: ['soul-md', 'migrate-soul'], slug: '迁移脚本' },
  { match: ['dsh-runtimes', 'clean-dsh', '会话归档'], slug: '磁盘与清理' },
  { match: ['recallTopN', 'transcript', '索引格式', 'writeTopic', 'noteRecall'], slug: '记忆系统细节' },
]

const FALLBACK_SUMMARY = '常驻条目压成索引句后留下的正文'

/** A one-sentence index line; the rest is prose and belongs in a topic. */
export function condense(entry, limit = ENTRY_MAX_CHARS) {
  const text = String(entry ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return { line: text, rest: '' }
  const sentence = text.split(/(?<=[。！？])/)[0]?.trim() ?? ''
  if (sentence && sentence.length <= limit) return { line: sentence, rest: text.slice(sentence.length).trim() }
  // No usable sentence break: cut at the last clause mark that still fits, and keep
  // the cut point (no ellipsis) so the index line reads like a sentence.
  let cut = -1
  for (const mark of ['；', '，', '、', '：']) {
    const at = text.lastIndexOf(mark, limit)
    if (at > limit * 0.5 && at > cut) cut = at
  }
  if (cut < 0) cut = Math.min(limit, text.length) - 1
  return { line: text.slice(0, cut).trim(), rest: text.slice(cut + 1).trim() }
}

function routeFor(entry) {
  const hit = ROUTES.find((route) => route.match.some((keyword) => entry.includes(keyword)))
  return hit?.slug ?? null
}

let planned = 0
for (const persona of list) {
  for (const target of wantedTargets) {
    const entries = readEntriesSync(persona, target)
    if (!entries.length) continue
    const topics = listTopicsSync(persona)
    const keep = []
    const moves = []
    for (const entry of entries) {
      const { line, rest } = condense(entry)
      if (!rest) {
        keep.push(line)
        continue
      }
      // Prose goes to the matching topic when the keywords are unambiguous, else to
      // one bucket per persona — autoSlug produced slugs like `0101加pnpmaud` that
      // nobody would ever search for.
      const slug = routeFor(entry) ?? `${persona}-细节`
      moves.push({ entry, line, rest, slug })
      keep.push(line)
    }
    const before = entries.join('\n§\n').length
    const after = keep.join('\n§\n').length
    console.log(`\n== ${persona} / ${target}：${entries.length} 条 ${before} 字 → ${keep.length} 条 ${after} 字，正文移出 ${moves.length} 段`)
    for (const move of moves) {
      console.log(`  · ${move.entry.length} 字 → 索引：${move.line}`)
      console.log(`    正文 ${move.rest.length} 字 → topics/${move.slug}.md`)
    }
    if (!moves.length || !apply) {
      if (!apply && moves.length) planned += moves.length
      continue
    }

    // Backup first, then write. Nothing below can lose the original text.
    const trash = path.join(DSH_HOME, 'trash')
    await mkdir(trash, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    const source = path.join(DSH_HOME, 'personas', persona, 'memory', `${target}.md`)
    if (existsSync(source)) {
      await rename(source, path.join(trash, `${stamp}-${persona}-${target}-${before}chars.md`))
    }
    await writeEntries(persona, target, keep)
    for (const move of moves) {
      const written = await writeTopic(persona, {
        slug: move.slug,
        summary: move.line.slice(0, 30),
        content: move.rest,
      })
      if (!written.ok) console.log(`    写入主题失败：${written.error}`)
    }
    await refreshMeta(persona)
    await writeTopicManifest(persona)
    const meta = readMetaSync(persona)
    console.log(`  已写入：索引 ${keep.length} 条；meta active ${Object.values(meta.entries ?? {}).filter((r) => r?.status === 'active').length}`)
  }
}

if (!apply) {
  console.log(planned ? `\n这是 dry-run：共 ${planned} 段正文待移出，未改动任何文件。确认后加 --apply。` : '\n没有需要拆分的条目。')
}
