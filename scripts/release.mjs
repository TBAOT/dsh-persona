/**
 * One command to cut a release: bump → changelog → commit → tag → push → pack → release.
 *
 * This exists because two hand-run steps drifted apart (tag `v0.13.2` while package.json
 * still said 0.13.1). Everything that must agree is derived from one number here.
 *
 *   node scripts/release.mjs patch --title "0.13.3：修复 xxx"
 *   node scripts/release.mjs minor --title "..." --notes-file notes.md --dry-run
 *   node scripts/release.mjs 0.14.0 --title "..." --no-push
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 0.13.2 + patch → 0.13.3; + minor → 0.14.0; + major → 1.0.0; explicit versions pass through. */
export function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(String(bump))) return String(bump)
  const [major, minor, patch] = String(current).split('.').map((part) => Number(part) || 0)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`不认识的版本参数：${bump}（用 patch / minor / major 或 x.y.z）`)
}

export function readFlags(args) {
  const positional = args.filter((item) => !item.startsWith('--'))
  const value = (name) => {
    const index = args.indexOf(`--${name}`)
    if (index === -1) return undefined
    const next = args[index + 1]
    return next && !next.startsWith('--') ? next : true
  }
  return { bump: positional[0], title: value('title'), notesFile: value('notes-file'), dryRun: Boolean(value('dry-run')), noPush: Boolean(value('no-push')) }
}

function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { bump, title, notesFile, dryRun, noPush } = readFlags(process.argv.slice(2))
  if (typeof title !== 'string') {
    console.error('缺少 --title：Release 横幅要用一句话说明这一版是什么。')
    process.exit(1)
  }

  const run = (command, argv) => {
    if (dryRun) {
      console.log(`  [dry-run] ${command} ${argv.join(' ')}`)
      return ''
    }
    return execFileSync(command, argv, { cwd: repo, encoding: 'utf8', stdio: 'inherit' })
  }
  const runShell = (line) => {
    if (dryRun) {
      console.log(`  [dry-run] ${line}`)
      return ''
    }
    return execFileSync(line, { cwd: repo, encoding: 'utf8', stdio: 'inherit', shell: true })
  }
  // A stale local proxy in git config (`http://127.0.0.1:10808` after the VPN dies) makes
  // every push fail while `gh` still works. Retry once with proxies disabled, then say
  // plainly what is left to do.
  const push = (argv) => {
    try {
      run(argv[0], argv.slice(1))
      return true
    } catch {
      console.log('  push 失败，改用 --no-proxy 重试（git 里可能配着已失效的本地代理）')
      try {
        run(argv[0], ['-c', 'http.proxy=', '-c', 'https.proxy=', ...argv.slice(1)])
        return true
      } catch {
        console.error(`\n本地已完成：commit 与 tag v${version} 都在。推送没成功，恢复命令：`)
        console.error(`  git -c http.proxy= push origin HEAD && git -c http.proxy= push origin v${version} --force`)
        console.error(`  gh release create v${version} --repo TBAOT/dsh-persona-kit --title "${title}" --notes-file "${notes ?? 'notes.md'}" <tgz>`)
        process.exit(1)
      }
    }
  }

  const pkgFile = path.join(repo, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  const version = nextVersion(pkg.version, bump ?? 'patch')

  if (!dryRun) {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()
    if (status) {
      console.error(`工作区不干净，先提交或 stash：\n${status}`)
      process.exit(1)
    }
  }

  console.log(`发布 ${pkg.version} → ${version}${dryRun ? '（dry-run）' : ''}`)

  pkg.version = version
  if (!dryRun) writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

  // 手写过的 CHANGELOG 优先：已有这一版的条目就不覆盖
  const changelogFile = path.join(repo, 'CHANGELOG.md')
  const changelog = readFileSync(changelogFile, 'utf8')
  if (changelog.includes(`## ${version}`)) {
    console.log(`  CHANGELOG 已有 ${version} 条目，保持原样`)
  } else {
    const entry = `## ${version}\n\n${title}\n\n- 待补\n\n`
    if (!dryRun) writeFileSync(changelogFile, changelog.replace('# 变更日志\n\n', `# 变更日志\n\n${entry}`), 'utf8')
    console.log(`  ${dryRun ? '将会写入' : '已写入'} CHANGELOG ${version} 条目（记得补要点）`)
  }

  run('git', ['add', '-A'])
  run('git', [
    '-c',
    'user.name=TBAOT',
    '-c',
    'user.email=tbaot@users.noreply.github.com',
    'commit',
    '-m',
    `chore(release): v${version} — ${title}`,
  ])
  run('git', ['tag', '-f', `v${version}`])

  if (noPush) {
    console.log('  --no-push：commit 与 tag 只留在本地')
  } else {
    push(['git', 'push', 'origin', 'HEAD'])
    push(['git', 'push', 'origin', `v${version}`, '--force'])
  }

  const outDir = path.join(os.tmpdir(), 'dsh-persona-release')
  // pnpm 在 Windows 上是 .cmd 垫片，execFile 直接调会 ENOENT；走 shell 最稳。
  runShell(`pnpm pack --pack-destination "${outDir}"`)
  const tarball = path.join(outDir, `dsh-persona-kit-${version}.tgz`)
  if (!dryRun && !existsSync(tarball)) {
    console.error(`找不到打包产物：${tarball}`)
    process.exit(1)
  }

  let notes = typeof notesFile === 'string' ? path.resolve(notesFile) : path.join(os.tmpdir(), `dsh-persona-notes-${version}.md`)
  if (typeof notesFile !== 'string' && !dryRun) {
    writeFileSync(notes, `# ${title}\n\n（用 --notes-file 指定这一版的说明；这是占位内容。）\n`, 'utf8')
    console.log(`  没有 --notes-file，用占位说明：${notes}`)
  }

  if (noPush) console.log('  --no-push：跳过 gh release')
  else run('gh', ['release', 'create', `v${version}`, '--repo', 'TBAOT/dsh-persona-kit', '--title', title, '--notes-file', notes, tarball])

  console.log(`\n完成：v${version}${dryRun ? '（dry-run，未落盘）' : ''}`)
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main()
