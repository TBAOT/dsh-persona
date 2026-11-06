/**
 * dsh-persona — persona roster (Host half).
 *
 * The roster is the one place that knows which persona exists, how it is
 * displayed, and which workspaces belong to it. Everything else (memory,
 * review, panel) keys off the persona id kept here.
 *
 * A persona is bound to workspaces, not to sessions: one persona can serve
 * several projects, and a session inherits its persona from the workspace its
 * working directory belongs to. That is what makes "one persona, many projects"
 * work while keeping the memory shared across those projects.
 */
import { promises as fs } from 'node:fs'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_LIMITS,
  memoryFile,
  parseEntries,
  personaDir,
  readEntries,
  resolveDshHome,
  sanitizeId,
  usage,
  writeEntries,
} from './store.js'
import { SLOT_COUNT } from './slots.js'

export const name = 'persona-roster'
export const inject = ['webServer']

const API_PREFIX = '/dsh-persona/api'
const INDEX_VERSION = 1
const MAX_BODY = 256 * 1024

/**
 * The bucket every session falls back to when its working directory belongs to
 * no persona: it is what the memory/review rows are configured with, and it is
 * deliberately absent from the roster. Sessions from unrelated projects share
 * it, so the panel surfaces it as a pool you can merge into a real persona.
 */
export const UNCLAIMED_ID = 'default'

export function registryFile(env = process.env) {
  return path.join(resolveDshHome(env), 'personas', 'index.json')
}

function emptyIndex() {
  return { version: INDEX_VERSION, personas: [] }
}

function normalizeWorkspace(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * The workspaces the app itself shows in its sidebar, read straight from the
 * durable registry file. Used as the fallback when the live service is not
 * reachable from this context (and in tests).
 */
export function workspacesFromStorage(env = process.env) {
  const file = path.join(resolveDshHome(env), 'storages', 'workspace.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const table = parsed?.tables?.workspaces
    if (!table || typeof table !== 'object') return []
    return Object.entries(table)
      .map(([id, value]) => ({
        id,
        path: typeof value?.path === 'string' ? value.path : '',
        title: typeof value?.title === 'string' && value.title.trim()
          ? value.title.trim()
          : path.basename(String(value?.path ?? '')),
        sessions: Array.isArray(value?.sessionIds) ? value.sessionIds.length : 0,
      }))
      .filter((item) => item.path)
  } catch {
    return []
  }
}

/** Live registry first, durable file second: both expose the same {id,path,title,sessions}. */
export function listWorkspacesSync(ctx, env = process.env) {
  let registry
  try {
    registry = ctx?.get?.('workspaceRegistry')
  } catch {
    registry = undefined
  }
  if (registry && typeof registry.list === 'function') {
    try {
      const items = registry.list()
      if (Array.isArray(items)) {
        return {
          source: 'registry',
          workspaces: items
            .filter((item) => item && typeof item.path === 'string')
            .map((item) => ({
              id: String(item.id ?? ''),
              path: item.path,
              title: typeof item.title === 'string' && item.title.trim()
                ? item.title.trim()
                : path.basename(item.path),
              sessions: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
            })),
        }
      }
    } catch {
      // fall through to the durable file
    }
  }
  const stored = workspacesFromStorage(env)
  return { source: stored.length ? 'storage' : 'none', workspaces: stored }
}

/** Which persona owns each normalised path, so the picker can show conflicts. */
export function ownerMap(index) {
  const map = new Map()
  for (const persona of index.personas) {
    for (const workspace of persona.workspaces) {
      map.set(normalizeWorkspace(workspace), { id: persona.id, name: persona.name })
    }
  }
  return map
}

export function readIndexFrom(text) {
  if (!text || !String(text).trim()) return emptyIndex()
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return emptyIndex()
    const personas = Array.isArray(parsed.personas) ? parsed.personas : []
    return {
      version: INDEX_VERSION,
      personas: personas
        .filter((entry) => entry && typeof entry.id === 'string')
        .map((entry) => ({
          id: sanitizeId(entry.id),
          name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : entry.id,
          presetId: typeof entry.presetId === 'string' ? entry.presetId : `persona-${sanitizeId(entry.id)}`,
          homeSessionId: typeof entry.homeSessionId === 'string' ? entry.homeSessionId : null,
          avatar: typeof entry.avatar === 'string' ? entry.avatar : '',
          workspaces: Array.isArray(entry.workspaces)
            ? entry.workspaces.filter((item) => typeof item === 'string' && item.trim())
            : [],
          limits: entry.limits && typeof entry.limits === 'object'
            ? {
                ...(Number(entry.limits.user) >= 100 ? { user: Math.floor(Number(entry.limits.user)) } : {}),
                ...(Number(entry.limits.memory) >= 100 ? { memory: Math.floor(Number(entry.limits.memory)) } : {}),
              }
            : undefined,
        })),
    }
  } catch {
    return emptyIndex()
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 100 ? Math.floor(number) : fallback
}

/** Sync read of the roster, for prompt assembly (which cannot await). */
export function readIndexSync(env = process.env) {
  try {
    return readIndexFrom(readFileSync(registryFile(env), 'utf8'))
  } catch {
    return emptyIndex()
  }
}

/** Character budgets for one persona; a stored value wins, otherwise the caller's default. */
export function limitsForPersona(index, id, fallback = DEFAULT_LIMITS) {
  const persona = index.personas.find((entry) => entry.id === sanitizeId(id))
  return {
    user: positiveInteger(persona?.limits?.user, positiveInteger(fallback.user, DEFAULT_LIMITS.user)),
    memory: positiveInteger(persona?.limits?.memory, positiveInteger(fallback.memory, DEFAULT_LIMITS.memory)),
  }
}

export async function readIndex(env = process.env) {
  try {
    return readIndexFrom(await fs.readFile(registryFile(env), 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyIndex()
    throw error
  }
}

export async function writeIndex(index, env = process.env) {
  const file = registryFile(env)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  await fs.rename(temp, file)
  return file
}

export function createPersona(index, input) {
  const name = String(input?.name ?? '').trim()
  if (!name) return { ok: false, error: '角色名不能为空' }
  const used = new Set(index.personas.map((entry) => entry.id))
  let slot = Number(input?.slot ?? 0)
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) {
    slot = 0
    for (let candidate = 1; candidate <= SLOT_COUNT; candidate += 1) {
      if (!used.has(`slot-${candidate}`)) {
        slot = candidate
        break
      }
    }
  }
  if (!slot) return { ok: false, error: `槽位已用满：最多 ${SLOT_COUNT} 个角色` }
  const id = `slot-${slot}`
  if (used.has(id)) return { ok: false, error: `槽位 ${slot} 已被占用` }
  const persona = {
    id,
    name,
    presetId: `persona-${id}`,
    homeSessionId: null,
    avatar: '',
    workspaces: [],
    limits: { user: DEFAULT_LIMITS.user, memory: DEFAULT_LIMITS.memory },
  }
  return { ok: true, index: { ...index, personas: [...index.personas, persona] }, persona }
}

export function updatePersona(index, id, patch) {
  const target = sanitizeId(id)
  const exists = index.personas.some((entry) => entry.id === target)
  if (!exists) return { ok: false, error: `没有这个角色：${target}` }
  const personas = index.personas.map((entry) => {
    if (entry.id !== target) return entry
    const next = { ...entry }
    if (typeof patch?.name === 'string' && patch.name.trim()) next.name = patch.name.trim()
    if (typeof patch?.avatar === 'string') next.avatar = patch.avatar
    if (typeof patch?.homeSessionId === 'string' || patch?.homeSessionId === null) {
      next.homeSessionId = patch.homeSessionId
    }
    if (patch?.limits && typeof patch.limits === 'object') {
      next.limits = {
        user: positiveInteger(patch.limits.user, next.limits?.user ?? DEFAULT_LIMITS.user),
        memory: positiveInteger(patch.limits.memory, next.limits?.memory ?? DEFAULT_LIMITS.memory),
      }
    }
    return next
  })
  return { ok: true, index: { ...index, personas } }
}

export function deletePersona(index, id) {
  const target = sanitizeId(id)
  const personas = index.personas.filter((entry) => entry.id !== target)
  if (personas.length === index.personas.length) return { ok: false, error: `没有这个角色：${target}` }
  return { ok: true, index: { ...index, personas } }
}

export function bindWorkspace(index, id, workspace) {
  const target = sanitizeId(id)
  const value = String(workspace ?? '').trim()
  if (!value) return { ok: false, error: '工作区路径不能为空' }
  if (!index.personas.some((entry) => entry.id === target)) {
    return { ok: false, error: `没有这个角色：${target}` }
  }
  const key = normalizeWorkspace(value)
  const personas = index.personas.map((entry) => {
    const workspaces = entry.workspaces.filter((item) => normalizeWorkspace(item) !== key)
    if (entry.id === target) workspaces.push(value)
    return { ...entry, workspaces }
  })
  return { ok: true, index: { ...index, personas } }
}

export function unbindWorkspace(index, id, workspace) {
  const target = sanitizeId(id)
  const key = normalizeWorkspace(workspace)
  const personas = index.personas.map((entry) =>
    entry.id === target
      ? { ...entry, workspaces: entry.workspaces.filter((item) => normalizeWorkspace(item) !== key) }
      : entry,
  )
  return { ok: true, index: { ...index, personas } }
}

/** Longest matching bound workspace wins, so nested projects resolve correctly. */
export function resolvePersonaForCwd(index, cwd) {
  const value = normalizeWorkspace(cwd)
  if (!value) return undefined
  let best
  for (const persona of index.personas) {
    for (const workspace of persona.workspaces) {
      const key = normalizeWorkspace(workspace)
      if (!key) continue
      if (value === key || value.startsWith(`${key}/`)) {
        if (!best || key.length > best.length) best = { persona, length: key.length }
      }
    }
  }
  return best?.persona
}

/** A bound path must be a real directory, otherwise the binding can never match a session. */
export function isDirectory(target) {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * Merge one pool tier into a persona tier.
 *
 * Duplicates are dropped, the target's own entries keep their order, and the
 * whole merge is refused when it does not fit — the caller writes nothing in
 * that case, so a failed adoption can never half-move someone's memory.
 */
export function planAdoption(targetEntries, incomingEntries, limit) {
  const merged = [...targetEntries]
  let added = 0
  for (const entry of incomingEntries) {
    const text = String(entry ?? '').trim()
    if (!text) continue
    if (merged.some((existing) => existing.trim() === text)) continue
    merged.push(text)
    added += 1
  }
  const size = usage(merged, limit)
  if (size.used > limit) {
    return {
      ok: false,
      error: `并入后超出上限：${size.used}/${size.limit} 字符，超出 ${size.used - limit}。先删几条，或把这个角色的上限调高。`,
      usage: size,
      overflow: size.used - limit,
    }
  }
  return { ok: true, entries: merged, added, usage: size }
}

function readBody(req) {  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

export function apply(ctx, config = {}) {
  const env = process.env

  const stateOf = async () => {
    const index = await readIndex(env)
    return {
      ...index,
      slotCount: SLOT_COUNT,
      personas: index.personas.map((persona) => ({
        ...persona,
        memoryDir: personaDir(persona.id, env),
        skillsDir: path.join(personaDir(persona.id, env), 'skills'),
      })),
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      async handler(req, res) {
        try {
          if (req.headers['x-dsh-persona'] !== '1') {
            send(res, 403, { error: 'forbidden' })
            return
          }
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const route = url.pathname.slice(API_PREFIX.length) || '/'

          if (req.method === 'GET' && route === '/list') {
            send(res, 200, await stateOf())
            return
          }

          if (req.method === 'GET' && route === '/workspaces') {
            const index = await readIndex(env)
            const owners = ownerMap(index)
            const listed = listWorkspacesSync(ctx, env)
            send(res, 200, {
              source: listed.source,
              workspaces: listed.workspaces.map((workspace) => {
                const owner = owners.get(normalizeWorkspace(workspace.path))
                return {
                  ...workspace,
                  boundTo: owner ? owner.id : null,
                  boundName: owner ? owner.name : null,
                }
              }),
            })
            return
          }

          if (req.method === 'GET' && route === '/unclaimed') {
            const index = await readIndex(env)
            const limits = limitsForPersona(index, UNCLAIMED_ID)
            const [userEntries, memoryEntries] = await Promise.all([
              readEntries(UNCLAIMED_ID, 'user', env),
              readEntries(UNCLAIMED_ID, 'memory', env),
            ])
            const listed = listWorkspacesSync(ctx, env)
            const free = listed.workspaces.filter((item) => !resolvePersonaForCwd(index, item.path))
            send(res, 200, {
              id: UNCLAIMED_ID,
              empty: !userEntries.length && !memoryEntries.length,
              user: { entries: userEntries, usage: usage(userEntries, limits.user) },
              memory: { entries: memoryEntries, usage: usage(memoryEntries, limits.memory) },
              workspaces: free.map((item) => ({
                id: item.id,
                title: item.title,
                path: item.path,
                sessions: item.sessions,
              })),
            })
            return
          }

          if (req.method === 'GET' && route === '/resolve') {
            const index = await readIndex(env)
            const persona = resolvePersonaForCwd(index, url.searchParams.get('cwd'))
            send(res, 200, { persona: persona ?? null })
            return
          }

          if (req.method === 'GET' && route === '/memory') {
            const id = sanitizeId(url.searchParams.get('id') ?? '')
            const target = String(url.searchParams.get('target') ?? 'memory')
            if (!['user', 'memory'].includes(target)) {
              send(res, 400, { error: 'target 必须是 user 或 memory' })
              return
            }
            const entries = await readEntries(id, target)
            const limits = limitsForPersona(await readIndex(env), id)
            send(res, 200, {
              id,
              target,
              entries,
              content: entries.join('\n\n§\n\n'),
              file: memoryFile(id, target, env),
              usage: usage(entries, limits[target]),
              limits,
            })
            return
          }

          if (req.method === 'GET' && route === '/review') {
            const id = sanitizeId(url.searchParams.get('id') ?? '')
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 30)))
            const file = path.join(personaDir(id, env), 'review', 'log.jsonl')
            let text = ''
            try {
              text = await fs.readFile(file, 'utf8')
            } catch {
              text = ''
            }
            const records = text
              .split(/\r?\n/)
              .filter(Boolean)
              .slice(-limit)
              .map((line) => {
                try {
                  return JSON.parse(line)
                } catch {
                  return { raw: line }
                }
              })
            send(res, 200, { id, records })
            return
          }

          const body = req.method === 'POST' ? await readBody(req) : {}
          const index = await readIndex(env)
          let result

          if (req.method === 'POST' && route === '/memory') {
            const id = sanitizeId(body.id ?? '')
            const target = String(body.target ?? 'memory')
            if (!['user', 'memory'].includes(target)) {
              send(res, 400, { error: 'target 必须是 user 或 memory' })
              return
            }
            if (!index.personas.some((entry) => entry.id === id) && id !== UNCLAIMED_ID) {
              send(res, 400, { error: `没有这个角色：${id}` })
              return
            }
            const entries = parseEntries(String(body.content ?? ''))
            const limits = limitsForPersona(index, id)
            const size = usage(entries, limits[target])
            if (size.used > size.limit) {
              send(res, 400, { error: `超出上限：${size.used}/${size.limit} 字符，超出 ${size.used - size.limit}` })
              return
            }
            const file = await writeEntries(id, target, entries, env)
            send(res, 200, { ok: true, id, target, usage: size, file, limits })
            return
          }

          if (req.method === 'POST' && route === '/limits') {
            const id = sanitizeId(body.id ?? '')
            const target = String(body.target ?? 'memory')
            if (!['user', 'memory'].includes(target)) {
              send(res, 400, { error: 'target 必须是 user 或 memory' })
              return
            }
            const limit = Number(body.limit)
            if (!Number.isFinite(limit) || limit < 200 || limit > 20000) {
              send(res, 400, { error: '上限需在 200–20000 字符之间' })
              return
            }
            const persona = index.personas.find((entry) => entry.id === id)
            if (!persona) {
              send(res, 400, { error: `没有这个角色：${id}` })
              return
            }
            const nextResult = updatePersona(index, id, {
              limits: { ...(persona.limits ?? {}), [target]: Math.floor(limit) },
            })
            if (!nextResult.ok) {
              send(res, 400, { error: nextResult.error })
              return
            }
            await writeIndex(nextResult.index, env)
            send(res, 200, { ok: true, id, limits: limitsForPersona(nextResult.index, id) })
            return
          }

          if (req.method === 'POST' && route === '/adopt') {
            const id = sanitizeId(body.id ?? '')
            if (!index.personas.some((entry) => entry.id === id)) {
              send(res, 400, { error: `没有这个角色：${id}` })
              return
            }
            const limits = limitsForPersona(index, id)
            const [poolUser, poolMemory, ownUser, ownMemory] = await Promise.all([
              readEntries(UNCLAIMED_ID, 'user', env),
              readEntries(UNCLAIMED_ID, 'memory', env),
              readEntries(id, 'user', env),
              readEntries(id, 'memory', env),
            ])
            if (!poolUser.length && !poolMemory.length) {
              send(res, 400, { error: '未认领池是空的' })
              return
            }
            const plans = {
              user: planAdoption(ownUser, poolUser, limits.user),
              memory: planAdoption(ownMemory, poolMemory, limits.memory),
            }
            const blocked = Object.entries(plans).find(([, plan]) => !plan.ok)
            if (blocked) {
              send(res, 400, { error: blocked[1].error, tier: blocked[0] })
              return
            }
            await writeEntries(id, 'user', plans.user.entries, env)
            await writeEntries(id, 'memory', plans.memory.entries, env)
            await writeEntries(UNCLAIMED_ID, 'user', [], env)
            await writeEntries(UNCLAIMED_ID, 'memory', [], env)
            send(res, 200, {
              ok: true,
              id,
              added: { user: plans.user.added, memory: plans.memory.added },
              usage: { user: plans.user.usage, memory: plans.memory.usage },
            })
            return
          }

          if (req.method === 'POST' && route === '/create') {
            result = createPersona(index, body)
          } else if (req.method === 'POST' && route === '/update') {
            result = updatePersona(index, body.id, body)
          } else if (req.method === 'POST' && route === '/delete') {
            result = deletePersona(index, body.id)
          } else if (req.method === 'POST' && route === '/bind') {
            let target = String(body.workspace ?? '').trim()
            const byId = Boolean(body.workspaceId)
            if (!target && byId) {
              const listed = listWorkspacesSync(ctx, env)
              target = listed.workspaces.find((item) => item.id === String(body.workspaceId))?.path ?? ''
              if (!target) {
                send(res, 400, { error: `没有这个工作区：${body.workspaceId}` })
                return
              }
            }
            if (target && !isDirectory(target)) {
              send(res, 400, { error: `目录不存在：${target}` })
              return
            }
            result = bindWorkspace(index, body.id, target)
          } else if (req.method === 'POST' && route === '/unbind') {
            result = unbindWorkspace(index, body.id, body.workspace)
          } else {
            send(res, 404, { error: 'not found' })
            return
          }

          if (!result.ok) {
            send(res, 400, { error: result.error })
            return
          }
          await writeIndex(result.index, env)
          send(res, 200, { ok: true, ...(result.persona ? { persona: result.persona } : {}) })
        } catch (error) {
          send(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  )

  return { rosterFile: registryFile(env), config }
}
