/**
 * 调试用：解压一个会话日志，打印指定事件类型的样例。
 * 用法：node scripts/debug-session.mjs <sessionDirName> [eventType]
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const root = path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh'), 'sessions')
const wanted = process.argv[2]
const eventType = process.argv[3] ?? 'user/message'

const dirs = []
for (const project of readdirSync(root)) {
  const projectDir = path.join(root, project)
  try {
    for (const session of readdirSync(projectDir)) {
      if (session.includes(wanted)) dirs.push(path.join(projectDir, session))
    }
  } catch {
    /* skip non-directories */
  }
}
if (!dirs.length) {
  console.error('找不到会话目录')
  process.exit(1)
}

const base = dirs[0]
const file = readdirSync(base).find((name) => name.endsWith('.zstd'))
const raw = readFileSync(path.join(base, file))
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
for (let i = 0; i <= raw.length - 4; i += 1) {
  if (raw[i] === magic[0] && raw[i + 1] === magic[1] && raw[i + 2] === magic[2] && raw[i + 3] === magic[3]) starts.push(i)
}
let text = ''
for (let k = 0; k < starts.length; k += 1) {
  const end = k + 1 < starts.length ? starts[k + 1] : raw.length
  try {
    text += zlib.zstdDecompressSync(raw.subarray(starts[k], end)).toString('utf8')
  } catch {
    /* partial frame */
  }
}
const lines = text.split('\n').filter(Boolean)
const hits = lines.filter((line) => line.includes(`"${eventType}"`))
console.log(`会话 ${path.basename(base)} 共 ${lines.length} 条事件，${eventType} 命中 ${hits.length} 条`)
console.log(hits[0]?.slice(0, 1200) ?? '(无)')
