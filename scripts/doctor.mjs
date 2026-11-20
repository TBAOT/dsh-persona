/**
 * `pnpm doctor` — check the profile before upgrading DSH.
 *
 * Run it *before* installing a new DSH: the failures it catches (an invalid loader entry,
 * a broken `link:` dependency) stop the app from starting, and their only symptom is
 * "the app won't open".
 */
import os from 'node:os'
import path from 'node:path'
import { inspectProfile } from '../lib/doctor.js'
import { readCompatSync } from '../lib/compat.js'

const arg = (name, fallback) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const profile = arg('profile', 'desktop')
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.join(home, 'profiles', profile)

const { problems, entries, dshVersion } = inspectProfile(profileDir)
const compat = readCompatSync()

console.log(`profile: ${profileDir}`)
console.log(`DSH（按 profile 依赖推断）: ${dshVersion ?? '未知'}`)
console.log(`补丁条目: ${entries.length} 个`)
console.log(`插件: ${compat ? `${compat.package ?? '?'} · ${compat.ok ? '接缝齐全' : `缺 ${(compat.missing ?? []).join('、')}`}` : '（还没探测结果）'}`)
if (compat?.lastError) console.log(`上次插件初始化失败: ${compat.lastError}`)

if (!problems.length) {
  console.log('\n没有问题：补丁条目符合 Loader 校验规则，link 依赖也能解析。')
  process.exit(0)
}

console.log(`\n发现 ${problems.length} 个问题：`)
for (const problem of problems) console.log(`  - ${problem.where}: ${problem.message}`)
console.log('\n这些正是"升级后应用打不开"的常见原因；修好再升级。')
process.exit(1)
