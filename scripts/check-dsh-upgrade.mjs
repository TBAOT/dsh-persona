/**
 * Watch DSH releases for breaks that touch the seams this plugin uses.
 *
 * DSH does not adapt plugins; it publishes an upgrade guide per release
 * (`docs/upgrade-guide/v<version>/<item>/guide.md`) and the plugin author migrates.
 * This script turns that into a scheduled check: compare the tested version with the
 * latest release, read the guides in between, and report the items that mention our
 * seams. It never edits code — it only makes the change visible before an upgrade.
 *
 *   node scripts/check-dsh-upgrade.mjs                # uses package.json dsh.testedAgainst
 *   node scripts/check-dsh-upgrade.mjs --tested 0.2.2-rc.1 --out report.md
 *
 * Exit code: 0 nothing matched, 1 seams affected (or the check could not run).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const REPO = 'deepseek-ai/deepseek-harness'
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split('=')[1]

/** What this plugin actually touches. Keep in sync with lib/compat.js + lib/memory.js. */
const SEAMS = [
  { name: 'agent/pre-step', pattern: /agent\/pre-step|PreStepDecision|pre-step/i },
  { name: 'systemPrompt.section', pattern: /systemPrompt\.section|PromptSection/i },
  { name: 'systemPrompt.context', pattern: /systemPrompt\.context|PromptContext|runtime-context/i },
  { name: 'llm/stream + TokenUsage', pattern: /TokenUsage|llm\/stream|FinishReason/i },
  // Narrow on purpose: the bare word "bundle" appears in almost every guide.
  { name: 'bundle/patch 装载', pattern: /cordis\.patch|patch\.yml|engines\.dsh/i },
  { name: 'client 模块装载', pattern: /__ModuleLoader__|client-module|client\s*模块/i },
  { name: 'session events', pattern: /turn-stopping|session\/event/i },
]

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const tested = arg('tested') ?? pkg?.dsh?.testedAgainst ?? null

const headers = { 'user-agent': 'dsh-persona-kit-upgrade-watch', accept: 'application/vnd.github+json' }
if (TOKEN) headers.authorization = `Bearer ${TOKEN}`

async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, { headers })
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`)
  return response.json()
}

/** File text through the API host (raw.githubusercontent.com is blocked on some networks). */
async function apiText(path) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { ...headers, accept: 'application/vnd.github.raw' },
  })
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`)
  return response.text()
}

/** Compare two DSH versions: 0.2.2-rc.1 < 0.2.2-rc.3 < 0.2.2 < 0.3.0. */
export function compareVersions(left, right) {
  const parse = (value) => {
    const [base, pre = ''] = String(value).replace(/^dsh-v?/, '').split('-')
    const numbers = base.split('.').map((part) => Number(part) || 0)
    while (numbers.length < 3) numbers.push(0)
    return { numbers, pre }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  }
  if (!a.pre && !b.pre) return 0
  if (!a.pre) return 1 // a release beats its own prerelease
  if (!b.pre) return -1
  const rank = (pre) => {
    const [stage, number = '0'] = pre.split('.')
    const order = { alpha: 0, beta: 1, rc: 2 }
    return [order[stage] ?? 3, Number(number) || 0]
  }
  const [sa, na] = rank(a.pre)
  const [sb, nb] = rank(b.pre)
  return sa - sb || na - nb
}

async function main() {
  if (!tested) throw new Error('缺少被测版本：在 package.json 的 dsh.testedAgainst 里写，或用 --tested=<ver>')
  const versions = (await api('contents/docs/upgrade-guide'))
    .filter((entry) => entry.type === 'dir')
    .map((entry) => entry.name.replace(/^v/, ''))
    .filter((version) => compareVersions(version, tested) > 0)
    .sort(compareVersions)

  if (!versions.length) {
    console.log(`没有晚于 ${tested} 的升级指南，无需检查。`)
    return { versions: [], matches: [] }
  }

  const matches = []
  for (const version of versions) {
    const items = (await api(`contents/docs/upgrade-guide/v${version}`)).filter((entry) => entry.type === 'dir')
    for (const item of items) {
      const files = await api(`contents/docs/upgrade-guide/v${version}/${item.name}`)
      const guide = files.find((file) => file.name === 'guide.zh.md') ?? files.find((file) => file.name === 'guide.md')
      if (!guide) continue
      const text = await apiText(`contents/docs/upgrade-guide/v${version}/${item.name}/${guide.name}`)
      // Match the title + first paragraphs only: guides frequently *mention* the patch
      // file in an unrelated migration step, and whole-body matching turned every such
      // mention into a false alarm.
      const head = text.split('\n').slice(0, 14).join('\n')
      const hit = SEAMS.find((seam) => seam.pattern.test(`${item.name}\n${head}`))
      if (!hit) continue
      const title = text.split('\n').find((line) => line.startsWith('# '))?.replace(/^#\s*/, '') ?? item.name
      matches.push({ version, item: item.name, seam: hit.name, title, url: guide.html_url })
    }
  }
  return { versions, matches }
}

// Only run when executed directly: the unit test imports `compareVersions` from here.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const { versions, matches } = await main()
  const lines = [
    `# DSH 升级接缝检查（被测版本 ${tested}）`,
    '',
    `检查的版本：${versions.length ? versions.join('、') : '无'}`,
    '',
  ]
  if (!matches.length) {
    lines.push('没有指南条目命中本插件用到的接缝。')
  } else {
    lines.push(`命中 ${matches.length} 条，升级前需要人工确认：`, '', '| 版本 | 条目 | 命中接缝 | 指南 |', '|---|---|---|---|')
    for (const match of matches) lines.push(`| ${match.version} | ${match.title}（${match.item}） | ${match.seam} | ${match.url} |`)
  }
  const report = lines.join('\n')
  console.log(report)
  const out = arg('out')
  if (out) writeFileSync(out, `${report}\n`, 'utf8')
  process.exit(matches.length ? 1 : 0)
}
