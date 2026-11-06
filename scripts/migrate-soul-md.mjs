/**
 * 把 soul-md 的卡片与记忆搬进 dsh-persona 的结构。
 *
 * 用法：
 *   node scripts/migrate-soul-md.mjs --patch <profile/cordis.patch.yml> --persona slot-1
 *   node scripts/migrate-soul-md.mjs --soul-md <$DSH_HOME/soul-md> --persona slot-1
 *
 * 规则：
 * - 每张卡片 → `personas/<角色>/skills/<卡片名>/SKILL.md`（卡片内容较长，放技能里按需读取）
 * - soul-md 的记忆文件 → `personas/<角色>/memory/memory.md` 的条目（超出上限时跳过并报告）
 * - 不删除任何源数据，可反复运行（同名技能会覆盖，重复条目会被去重）
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import YAML from 'yaml'
import { parseEntries, formatEntries, usage, applyOperations, DEFAULT_LIMITS } from '../lib/store.js'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const persona = readArg('persona', 'slot-1')
const patchPath = readArg('patch', path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'))
const soulDir = readArg('soul-md', path.join(dshHome, 'soul-md'))

const personaDir = path.join(dshHome, 'personas', persona)

const slug = (value) =>
  String(value)
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'card'

async function readCards() {
  try {
    const doc = YAML.parse(await readFile(patchPath, 'utf8'))
    const row = (doc ?? []).find((entry) => entry && entry.id === 'soul-md')
    const cards = row?.config?.cards
    return cards && typeof cards === 'object' ? cards : {}
  } catch (error) {
    console.warn(`读取卡片失败（${patchPath}）：${error.message}`)
    return {}
  }
}

async function readSoulMemory() {
  const files = []
  const walk = async (dir, depth = 0) => {
    if (depth > 3) return
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.name.toLowerCase().endsWith('.md')) files.push(full)
    }
  }
  await walk(path.join(soulDir, 'memory'))
  const out = []
  for (const file of files) {
    const text = (await readFile(file, 'utf8')).trim()
    if (text) out.push({ file, text })
  }
  return out
}

const cards = await readCards()
const memories = await readSoulMemory()

let skills = 0
for (const [name, text] of Object.entries(cards)) {
  const dir = path.join(personaDir, 'skills', slug(name))
  await mkdir(dir, { recursive: true })
  const body = [
    '---',
    `name: ${slug(name)}`,
    `description: 从 soul-md 迁移的角色卡片：${name}`,
    'whenToUse: 需要这个角色的项目背景、约定或工作纪律时',
    '---',
    '',
    String(text).trim(),
    '',
  ].join('\n')
  await writeFile(path.join(dir, 'SKILL.md'), body, 'utf8')
  skills += 1
}

await mkdir(path.join(personaDir, 'memory'), { recursive: true })
const memoryFile = path.join(personaDir, 'memory', 'memory.md')
let entries = []
try {
  entries = parseEntries(await readFile(memoryFile, 'utf8'))
} catch {
  entries = []
}

let added = 0
let skipped = []
for (const item of memories) {
  const result = applyOperations(entries, [{ action: 'add', content: item.text }], DEFAULT_LIMITS.memory)
  if (result.ok) {
    entries = result.entries
    added += 1
  } else {
    skipped.push(path.relative(soulDir, item.file))
  }
}

await writeFile(memoryFile, formatEntries('memory', entries), 'utf8')
const size = usage(entries, DEFAULT_LIMITS.memory)

// Whatever does not fit the memory budget becomes a reference file inside the
// persona's skill folder, so nothing is lost and the prompt stays bounded.
const overflow = []
for (const item of memories) {
  if (!skipped.includes(path.relative(soulDir, item.file))) continue
  const target = path.join(personaDir, 'skills', `${slug(path.basename(item.file, '.md'))}.md`)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(
    target,
    ['---', `name: ${slug(path.basename(item.file, '.md'))}`, 'description: 从 soul-md 迁移的笔记', '---', '', item.text, ''].join('\n'),
    'utf8',
  )
  overflow.push(target)
}

console.log(`角色 ${persona}`)
console.log(`  卡片 → 技能：${skills} 个`)
console.log(`  记忆 → 条目：新增 ${added} 条，占用 ${size.used}/${size.limit}（${size.percent}%）`)
if (overflow.length) console.log(`  超出记忆上限、已转为技能笔记：${overflow.map((file) => path.relative(personaDir, file)).join('、')}`)
console.log('源数据未改动，可重复运行。')
