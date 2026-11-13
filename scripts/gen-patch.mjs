/**
 * Generate `cordis.patch.yml`.
 *
 * The patch only carries the four service rows. Personas are runtime data
 * (roster + memory/skill directories), not declared presets, so nothing here
 * needs a per-user absolute path — which a bundle patch cannot express.
 *
 * Run: `node scripts/gen-patch.mjs`
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SLOT_COUNT } from '../lib/slots.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(here, '..', 'cordis.patch.yml')

const rows = [
  { id: 'persona-memory', name: 'dsh-persona', config: { personaId: 'default', routeThreshold: 0.9 } },
  { id: 'persona-review', name: 'dsh-persona/review', config: { personaId: 'default', routeThreshold: 0.9 } },
  { id: 'persona-roster', name: 'dsh-persona/roster', config: {} },
  { id: 'persona-skills', name: 'dsh-persona/skills', config: {} },
]

const header = [
  '# dsh-persona 生成的补丁：不要手改。改完代码后运行：',
  '#   node scripts/gen-patch.mjs && node scripts/check-patch.mjs',
  `# 角色是运行时数据（名册 + 记忆/技能目录），不是声明的预设；槽位数 ${SLOT_COUNT}。`,
  '',
].join('\n')

const emitRow = (row) => {
  const lines = [`    - id: ${JSON.stringify(row.id)}`, `      name: ${JSON.stringify(row.name)}`]
  const keys = Object.keys(row.config ?? {})
  if (!keys.length) {
    lines.push('      config: {}')
    return lines.join('\n')
  }
  lines.push('      config:')
  for (const key of keys) lines.push(`        ${key}: ${JSON.stringify(row.config[key])}`)
  return lines.join('\n')
}

await writeFile(target, `${header}- insert:\n${rows.map(emitRow).join('\n')}\n`, 'utf8')
console.log(`已生成 ${target}（${rows.length} 行）`)
