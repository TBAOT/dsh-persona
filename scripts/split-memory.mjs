/**
 * Split the resident memory into resident + topics.
 *
 * The resident files are for what is always worth reading: identity, preferences,
 * rules. Procedure and reference material belongs in the topic library, where the
 * prompt only carries a pointer. This script moves the second kind, and is safe
 * to run twice: anything already moved simply no longer matches.
 *
 *   node scripts/split-memory.mjs --dry-run
 *   node scripts/split-memory.mjs --apply
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { TOPIC_MAX_CHARS } from '../lib/topics.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const persona = process.argv.find((arg) => arg.startsWith('--persona='))?.split('=')[1] ?? 'slot-1'

/** Where each kind of detail should live. Matched by substring, first hit wins. */
const ROUTES = [
  { match: '记忆方案', slug: '记忆方案文档', summary: '技术方案 01–10 的位置与丢失后的恢复办法' },
  { match: 'migrate-soul-md', slug: '迁移脚本', summary: 'soul-md 人设卡迁入 personas 的脚本行为' },
  { match: '换 GitHub token', slug: 'github-token', summary: '换 GitHub token 的三步与导入脚本' },
  { match: '磁盘与运维', slug: '磁盘与清理', summary: '清理脚本、会话归档判据与 dsh-runtimes 的位置' },
]

const memoryFile = path.join(DSH_HOME, 'personas', persona, 'memory', 'memory.md')
const topicsDir = path.join(DSH_HOME, 'personas', persona, 'topics')

const raw = await readFile(memoryFile, 'utf8')
const header = raw.split(/\r?\n/)[0]
const entries = raw
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('<!--'))
  .join('\n')
  .split(/\r?\n§\r?\n/)
  .map((entry) => entry.trim())
  .filter(Boolean)

const stay = []
const moves = []
for (const entry of entries) {
  const route = ROUTES.find((item) => entry.includes(item.match))
  if (route) moves.push({ entry, route })
  else stay.push(entry)
}

const before = raw.length
const after = entriesToText(header, stay).length
console.log(`persona=${persona}  条目 ${entries.length} → ${stay.length}；字符 ${before} → ${after}`)
for (const move of moves) console.log(`  移动 → ${move.route.slug}（${move.entry.length} 字符）`)
if (!moves.length) {
  console.log('没有需要移动的条目。')
  process.exit(0)
}

if (!apply) {
  console.log('\n这是 dry-run，没有改动。确认后加 --apply。')
  process.exit(0)
}

await mkdir(topicsDir, { recursive: true })
for (const move of moves) {
  const file = path.join(topicsDir, `${move.route.slug}.md`)
  const prev = existsSync(file) ? await readFile(file, 'utf8') : ''
  const body = prev
    ? `${prev.trimEnd()}\n\n## ${new Date().toISOString().slice(0, 10)}\n\n${move.entry}\n`
    : `---\nslug: ${move.route.slug}\nsummary: ${move.route.summary}\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n${move.entry}\n`
  if (body.length > TOPIC_MAX_CHARS) throw new Error(`主题 ${move.route.slug} 超过 ${TOPIC_MAX_CHARS} 字符`)
  await writeFile(file, body, 'utf8')
}

const backupDir = path.join(DSH_HOME, 'trash')
await mkdir(backupDir, { recursive: true })
const stamp = new Date().toISOString().slice(0, 10)
await rename(memoryFile, path.join(backupDir, `${stamp}-${persona}-memory-${before}chars.md`))
await writeFile(memoryFile, entriesToText(header, stay), 'utf8')
console.log(`\n完成：${moves.length} 条移入 topics/，原文备份到 trash/。`)

function entriesToText(head, list) {
  return `${head}\n${list.join('\n§\n')}\n`
}
