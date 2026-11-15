/**
 * `pnpm audit` — structural hygiene for one persona's memory.
 *
 * Errors (exit 1): empty topic summary, topic over its cap, near-duplicate topics,
 * duplicate facts (inside a tier or across user/memory), meta drifting from files.
 * Advisories (exit 0): missing retrieval aliases, very long entries, a tier near
 * its limit. Judgement about what a fact is worth stays with the human.
 */
import { readdirSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { auditPersona, formatAudit } from '../lib/audit.js'
import { readIndexSync } from '../lib/roster.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const personaArg = process.argv.find((item) => item.startsWith('--persona='))?.split('=')[1]

const personasDir = path.join(DSH_HOME, 'personas')
const candidates = personaArg
  ? [personaArg]
  : readdirSync(personasDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

const index = readIndexSync(process.env)
const limitsOf = (id) => index?.personas?.find((entry) => entry.id === id)?.limits ?? { user: 1375, memory: 3000 }

let errors = 0
let checked = 0
for (const persona of candidates) {
  if (!existsSync(path.join(personasDir, persona, 'memory'))) continue
  const report = auditPersona(persona, { limits: limitsOf(persona) })
  checked += 1
  console.log(formatAudit(report))
  console.log('')
  errors += report.errors
}

if (!checked) {
  console.log('没有可审计的角色（缺 <DSH_HOME>/personas/<id>/memory 目录）')
  process.exit(0)
}
if (errors) {
  console.error(`审计失败：${errors} 个错误需要修（提醒项不影响退出码）。`)
  process.exit(1)
}
console.log(`审计通过：${checked} 个角色没有结构性错误。`)
