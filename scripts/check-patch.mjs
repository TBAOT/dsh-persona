/**
 * Structural check of the generated patch.
 *
 * Everything here is ordinary YAML: the patch declares four service rows and
 * nothing else. Personas live in the roster at runtime, so a per-user absolute
 * path never has to appear in the file.
 *
 * Run: `node scripts/check-patch.mjs`
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '..', 'cordis.patch.yml')
const raw = readFileSync(file, 'utf8')

const fail = (message) => {
  console.error(`✖ ${message}`)
  process.exitCode = 1
}

if (/!!js/.test(raw)) fail('补丁不应包含 !!js（当前加载器不接受该标签）')

let doc
try {
  doc = YAML.parse(raw)
} catch (error) {
  console.error(`YAML 解析失败：${error.message}`)
  process.exit(1)
}

if (!Array.isArray(doc)) fail('顶层必须是数组')
const rows = doc?.[0]?.insert
if (!Array.isArray(rows)) fail('第一项必须带 insert 列表')

const expected = {
  'persona-memory': 'dsh-persona',
  'persona-review': 'dsh-persona/review',
  'persona-roster': 'dsh-persona/roster',
  'persona-skills': 'dsh-persona/skills',
}

for (const [id, name] of Object.entries(expected)) {
  const row = rows.find((entry) => entry.id === id)
  if (!row) {
    fail(`缺少服务行：${id}`)
    continue
  }
  if (row.name !== name) fail(`${id} 的插件名应为 ${name}，实际 ${row.name}`)
}

if (rows.length !== 4) fail(`补丁应只有 4 行服务行，实际 ${rows.length}`)
if (rows.some((row) => String(row.id).startsWith('preset-'))) fail('不应再声明预设行')

if (!process.exitCode) {
  console.log(`✔ 补丁结构正常：${rows.length} 行服务行，无 !!js，无预设`)
}
