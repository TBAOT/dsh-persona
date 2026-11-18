/**
 * Deleting a persona must not silently destroy its memory.
 *
 * The directory is moved into `~/.dsh/trash/<date>-<kind>-<id>/`, so "delete the role"
 * means "off the roster, recoverable on disk" — the same rule the rest of this plugin
 * follows for invalidated entries and overwritten files.
 */
import { existsSync, mkdirSync, renameSync, cpSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function trashRoot(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'trash')
}

function uniqueDir(parent, name) {
  let candidate = path.join(parent, name)
  let suffix = 2
  while (existsSync(candidate)) {
    candidate = path.join(parent, `${name}-${suffix}`)
    suffix += 1
  }
  return candidate
}

export function moveToTrash(source, { kind = 'persona', id = 'item', env = process.env } = {}) {
  if (!existsSync(source)) return { moved: false, reason: 'source-missing' }
  const stamp = new Date().toISOString().slice(0, 10)
  const base = `${stamp}-${kind}-${id}`
  mkdirSync(trashRoot(env), { recursive: true })
  const target = uniqueDir(trashRoot(env), base)
  try {
    renameSync(source, target)
    return { moved: true, to: target }
  } catch (error) {
    // A rename can fail across volumes or while a handle is open; copying keeps the data.
    try {
      cpSync(source, target, { recursive: true })
      rmSync(source, { recursive: true, force: true })
      return { moved: true, to: target, via: 'copy' }
    } catch (copyError) {
      return { moved: false, reason: String(copyError?.code ?? copyError) }
    }
  }
}
