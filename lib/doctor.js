/**
 * Pre-flight checks for a profile, aimed at the failure that has no log: the app refuses
 * to start after an upgrade.
 *
 * Since DSH 0.2.2-rc.3 the Loader validates entry options, and a rejected *required*
 * entry terminates startup (`docs/upgrade-guide/v0.2.2-rc.3/cordis-loader-entry-validation`).
 * That happens before any plugin loads, so nothing of ours can catch it — the only defence
 * is to check the profile before upgrading.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** `!!js` expressions survive as tagged scalars; accept whatever shape they come back in. */
function isExpression(value) {
  if (typeof value === 'string') return value.startsWith('!!js')
  return isPlainObject(value) && value.type === 'js'
}

/** `!!js` is DSH's own tag; give the parser a definition so such files still parse. */
const JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value) => ({ type: 'js', source: typeof value === 'string' ? value : String(value ?? '') }),
}

export function parsePatch(text) {
  try {
    const document = parseDocument(text, { customTags: [JS_TAG], logLevel: 'silent' })
    if (document.errors.length) return { ok: false, error: document.errors[0].message }
    const value = document.toJS()
    if (value == null) return { ok: true, entries: [] }
    if (!Array.isArray(value)) return { ok: false, error: '补丁文件的顶层必须是数组' }
    return { ok: true, entries: value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Rules from the rc.3 loader: `name`, `group`, `disabled`, `inject`, `isolate`, group config. */
export function validateEntries(entries) {
  const problems = []
  const note = (where, message) => problems.push({ where, message })

  const checkEntry = (entry, where) => {
    if (!isPlainObject(entry)) {
      note(where, `条目必须是映射，现在是 ${Array.isArray(entry) ? '列表' : typeof entry}`)
      return
    }
    if (!('name' in entry)) note(where, '缺少 name')
    else if (typeof entry.name !== 'string') note(where, `name 必须是字符串（现在是 ${typeof entry.name}）`)

    if ('group' in entry && typeof entry.group !== 'boolean') note(where, `group 必须是布尔值（现在是 ${typeof entry.group}）`)
    if ('disabled' in entry && typeof entry.disabled !== 'boolean' && !isExpression(entry.disabled)) {
      note(where, 'disabled 必须是布尔值或 !!js 表达式')
    }
    if (entry.group === true) {
      if (!('config' in entry)) note(where, 'group: true 必须带 config 列表（空列表也要写 []）')
      else if (!Array.isArray(entry.config)) note(where, 'group: true 的 config 必须是列表')
      else entry.config.forEach((child, index) => checkEntry(child, `${where}.config[${index}]`))
    }
    if ('inject' in entry) {
      const list = Array.isArray(entry.inject) && entry.inject.every((item) => typeof item === 'string')
      if (!list && !isPlainObject(entry.inject)) note(where, 'inject 必须是字符串列表或映射')
    }
    if ('isolate' in entry) {
      if (!isPlainObject(entry.isolate)) note(where, 'isolate 必须是映射')
      else {
        for (const [key, value] of Object.entries(entry.isolate)) {
          if (value !== true && typeof value !== 'string') note(`${where}.isolate.${key}`, 'isolate 的值必须是 true 或字符串')
        }
      }
    }
  }

  entries.forEach((entry, index) => {
    if (isPlainObject(entry) && Array.isArray(entry.insert)) {
      if (!entry.insert.length) note(`[${index}].insert`, 'insert 列表是空的')
      entry.insert.forEach((child, childIndex) => checkEntry(child, `[${index}].insert[${childIndex}]`))
      return
    }
    checkEntry(entry, `[${index}]`)
  })
  return problems
}

/** `link:` dependencies must point at a real package and be installed in the profile. */
export function checkDependencies(pkg, profileDir) {
  const problems = []
  for (const [name, spec] of Object.entries(pkg?.dependencies ?? {})) {
    const value = String(spec)
    if (!value.startsWith('link:')) continue
    const target = value.slice('link:'.length)
    if (!existsSync(path.join(target, 'package.json'))) {
      problems.push({ where: name, message: `link 指向的目录没有 package.json：${target}` })
      continue
    }
    if (!existsSync(path.join(profileDir, 'node_modules', name, 'package.json'))) {
      problems.push({ where: name, message: 'node_modules 里没有它，跑一次 pnpm install' })
    }
  }
  return problems
}

/** The DSH version this profile was installed against, taken from the first core dep. */
export function dshVersionOf(pkg) {
  const deps = pkg?.dependencies ?? {}
  for (const [name, version] of Object.entries(deps)) {
    if (name.startsWith('@deepseek-ai/dsh-')) return String(version)
  }
  return null
}

export function inspectProfile(profileDir) {
  const pkgFile = path.join(profileDir, 'package.json')
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const problems = []
  let pkg = null
  let entries = []

  if (!existsSync(pkgFile)) problems.push({ where: 'package.json', message: '文件不存在' })
  else {
    try {
      pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    } catch (error) {
      problems.push({ where: 'package.json', message: `不是合法 JSON：${error.message}` })
    }
  }

  if (pkg) {
    const bundles = pkg?.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || !bundles.length) problems.push({ where: 'dsh.profile.bundles', message: '为空或不是列表' })
    problems.push(...checkDependencies(pkg, profileDir).map((item) => ({ where: `deps:${item.where}`, message: item.message })))
  }

  if (existsSync(patchFile)) {
    const parsed = parsePatch(readFileSync(patchFile, 'utf8'))
    if (!parsed.ok) problems.push({ where: 'cordis.patch.yml', message: `解析失败：${parsed.error}` })
    else {
      entries = parsed.entries
      problems.push(...validateEntries(entries).map((item) => ({ where: `patch${item.where}`, message: item.message })))
    }
  }

  return { pkg, entries, problems, dshVersion: dshVersionOf(pkg) }
}
