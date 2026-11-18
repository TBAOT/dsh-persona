/**
 * One-time migration: rename personas from `slot-N` to the name you gave them.
 *
 * Runs at plugin start, before any session has opened a file under `personas/`, which is
 * the only window where Windows lets us rename those directories — doing it while the app
 * runs fails with EPERM because the running sessions hold handles.
 *
 * Rules:
 *  - only ids shaped like `slot-<n>` are touched; `default` and user-chosen ids stay;
 *  - the target id is `sanitizeId(name)`; a name that is empty, taken, or already has a
 *    directory is skipped and reported instead of being overwritten;
 *  - the directory is renamed first, then `index.json` is written once; a persona whose
 *    rename fails keeps its old id, so the index never points at a missing directory.
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitizeId } from './store.js'

const SLOT_SHAPE = /^slot-\d+$/

export function migratePersonaIds(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const personasDir = path.join(home, 'personas')
  const indexFile = path.join(personasDir, 'index.json')
  if (!existsSync(indexFile)) return { renamed: [], skipped: [], changed: false }

  let index
  try {
    index = JSON.parse(readFileSync(indexFile, 'utf8'))
  } catch {
    return { renamed: [], skipped: [{ reason: 'index.json 无法解析' }], changed: false }
  }
  if (!Array.isArray(index.personas)) return { renamed: [], skipped: [], changed: false }

  const taken = new Set(index.personas.map((entry) => entry.id))
  const renamed = []
  const skipped = []

  for (const persona of index.personas) {
    if (!SLOT_SHAPE.test(String(persona.id ?? ''))) continue
    const target = sanitizeId(persona.name, '')
    if (!target || target === persona.id) {
      skipped.push({ id: persona.id, reason: '名字不能作为目录名' })
      continue
    }
    if (taken.has(target)) {
      skipped.push({ id: persona.id, reason: `目标 id 已被占用：${target}` })
      continue
    }
    const from = path.join(personasDir, persona.id)
    const to = path.join(personasDir, target)
    if (!existsSync(from) || (existsSync(to) && !statSync(to).isDirectory())) {
      skipped.push({ id: persona.id, reason: '目录不存在或目标冲突' })
      continue
    }
    if (existsSync(to)) {
      skipped.push({ id: persona.id, reason: `目标目录已存在：${target}` })
      continue
    }
    try {
      renameSync(from, to)
    } catch (error) {
      skipped.push({ id: persona.id, reason: `改名失败：${error?.code ?? error}` })
      continue
    }
    persona.previousIds = [...(persona.previousIds ?? []), persona.id]
    persona.id = target
    persona.presetId = `persona-${target}`
    taken.delete(persona.id)
    taken.add(target)
    renamed.push({ from: persona.previousIds.at(-1), to: target })
  }

  if (renamed.length) {
    writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  }
  return { renamed, skipped, changed: renamed.length > 0 }
}

/** Persona directories present on disk but absent from the index (diagnostics only). */
export function orphanDirs(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const personasDir = path.join(home, 'personas')
  if (!existsSync(personasDir)) return []
  const indexFile = path.join(personasDir, 'index.json')
  let known = new Set()
  try {
    const index = JSON.parse(readFileSync(indexFile, 'utf8'))
    known = new Set((index.personas ?? []).map((entry) => entry.id))
  } catch {
    return []
  }
  return readdirSync(personasDir).filter(
    (name) => name !== 'index.json' && !known.has(name) && statSync(path.join(personasDir, name)).isDirectory(),
  )
}
