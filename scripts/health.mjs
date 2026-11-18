/**
 * `pnpm health` — is recall actually injecting, and are the token numbers real?
 *
 * Reads `<DSH_HOME>/personas/<id>/review/metrics.jsonl` for every persona that has
 * one and prints a verdict from the last few turns. Exits non-zero when a persona
 * reports a broken or silently-dead recall path, so this can gate a release check.
 *
 *   node scripts/health.mjs                    # every persona with metrics
 *   node scripts/health.mjs --persona=slot-1
 *   node scripts/health.mjs --window=10 --all  # include personas idle for weeks
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { summarizeMetrics, formatHealth } from '../lib/health.js'
import { readCompatSync } from '../lib/compat.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split('=')[1]
const personaArg = arg('persona')
const windowSize = Number(arg('window') ?? 5)
const includeStale = process.argv.includes('--all')

const personasDir = path.join(DSH_HOME, 'personas')
const personas = personaArg
  ? [personaArg]
  : readdirSync(personasDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

let failed = []
let unverified = 0
let verified = 0
let checked = 0
for (const persona of personas) {
  const file = path.join(personasDir, persona, 'review', 'metrics.jsonl')
  if (!existsSync(file)) continue
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  if (!rows.length) continue
  const summary = summarizeMetrics(rows, { window: windowSize })
  if (summary.verdict === 'stale' && !includeStale) continue
  checked += 1
  if (summary.verdict === 'ok') verified += 1
  console.log(formatHealth(persona, summary))
  if (summary.verdict === 'unverified') {
    unverified += 1
    console.log('   注意：窗口内每条都记成 unknown——这是指标归属缺陷（0.8.4 及更早没有按 turn 记录），',
      '不能据此判断召回生死；升级到 0.9.0+ 并重载后会变成 injected / no-match。')
  }
  if (['broken', 'silent'].includes(summary.verdict)) failed.push({ persona, verdict: summary.verdict })
}

if (!checked) {
  console.log(`没有可评估的 metrics（${path.join(personasDir, '*', 'review', 'metrics.jsonl')}）`)
  process.exit(0)
}
// Host compatibility, written by the plugin at apply() time.
const compat = readCompatSync(DSH_HOME ? { ...process.env, DSH_HOME } : process.env)
if (compat) {
  const missing = compat.missing ?? []
  const degraded = compat.degraded ?? []
  const version = compat.package ?? '?'
  console.log(
    `\n宿主兼容：插件 ${version} · ${missing.length ? `缺必需接口 ${missing.join('、')}` : '必需接口齐全'}` +
      `${degraded.length ? ` · 降级 ${degraded.join('、')}` : ''} · 召回走 ${compat.recallMode ?? '?'}（${compat.at ?? ''}）`,
  )
  if (missing.length) {
    console.error('失败：宿主缺少必需接口，插件无法正常工作——这通常意味着 DSH 做了不兼容升级。')
    process.exit(1)
  }
} else {
  console.log('\n宿主兼容：还没有探测结果（插件未在本进程加载过，或从未重载）。')
}
if (failed.length) {
  console.error(`\n失败：${failed.map((item) => `${item.persona}=${item.verdict}`).join('，')}`)
  console.error('broken = 注入形状/异常失败；silent = 窗口内该注入却一次都没注入（0.8.0–0.8.3 就是这个状态）。')
  process.exit(1)
}
console.log(
  `\n体检：${checked} 个角色，其中 ${verified} 个最近窗口里有召回注入、${unverified} 个指标记成 unknown（无法判定）。`,
)
