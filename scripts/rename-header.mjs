// 把旧头部 <!-- dsh-persona v1 ... --> 改写为新名字（条目内容原样保留），并同步 meta。
// 备份到 ~/.dsh/trash/<日期>-header-rename/ 下，改不动就停。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatEntries, LEGACY_HEADER_PREFIX, parseEntries, refreshMeta } from '../lib/store.js'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const personasDir = path.join(home, 'personas')
const stamp = new Date().toISOString().slice(0, 10)
const trash = path.join(home, 'trash', `${stamp}-header-rename`)
mkdirSync(trash, { recursive: true })

let rewritten = 0
const personas = readdirSync(personasDir).filter((name) => existsSync(path.join(personasDir, name, 'memory')))
for (const persona of personas) {
  for (const target of ['user', 'memory']) {
    const file = path.join(personasDir, persona, 'memory', `${target}.md`)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    if (!text.includes(LEGACY_HEADER_PREFIX)) continue
    const entries = parseEntries(text)
    copyFileSync(file, path.join(trash, `${persona}-${target}.md`))
    writeFileSync(file, formatEntries(target, entries), 'utf8')
    rewritten += 1
    console.log(`rewrote ${persona}/${target}.md (${entries.length} 条)`)
  }
  await refreshMeta(persona)
  console.log(`refreshed meta: ${persona}`)
}
console.log(`完成：改写 ${rewritten} 个文件，备份在 ${trash}`)
