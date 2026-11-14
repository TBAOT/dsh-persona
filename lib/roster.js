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
import { existsSync, readdirSync, readFileSync, renameSync, statSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_LIMITS,
  memoryFile,
  parseEntries,
  personaDir,
  readEntries,
  readMetaSync,
  resolveDshHome,
  sanitizeId,
  usage,
  writeEntries,
} from './store.js'
import { SLOT_COUNT } from './slots.js'
import { archiveTopic, isTopicExpired, listTopicsSync, topicsDir, writeTopic, writeTopicManifest } from './topics.js'

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

/** The workspace a Session was opened in, from the projection cache it already keeps. */
export function sessionCwd(sessionId, env = process.env) {
  const id = String(sessionId ?? '').trim()
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) return null
  try {
    const file = path.join(resolveDshHome(env), 'storages', 'session_projcache', 'sessions', `${id}.json`)
    const record = JSON.parse(readFileSync(file, 'utf8'))?.record
    const cwd = record?.identity?.cwd
    return typeof cwd === 'string' && cwd ? cwd : null
  } catch {
    return null
  }
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

/** Front matter of a skill file: description / whenToUse, plus its byte size. */
export function skillMeta(file) {
  try {
    const text = readFileSync(file, 'utf8')
    const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const field = (key) => {
      if (!block) return ''
      const hit = block[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
      return hit ? hit[1].trim().replace(/^["']|["']$/g, '') : ''
    }
    return { description: field('description'), whenToUse: field('whenToUse'), bytes: Buffer.byteLength(text) }
  } catch {
    return { description: '', whenToUse: '', bytes: 0 }
  }
}

/** Private skills of one persona: `<name>/SKILL.md` and flat `<name>.md`. */
export function listSkills(id, env = process.env) {
  const target = sanitizeId(id)
  const dir = path.join(personaDir(target, env), 'skills')
  const out = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { id: target, dir, skills: [] }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const file = path.join(dir, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      out.push({ name: entry.name, kind: 'dir', path: file, ...skillMeta(file) })
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const file = path.join(dir, entry.name)
      out.push({ name: entry.name.replace(/\.md$/i, ''), kind: 'flat', path: file, ...skillMeta(file) })
    }
  }
  out.sort((left, right) => left.name.localeCompare(right.name))
  return { id: target, dir, skills: out }
}

/** Move one skill (file or directory) to another persona's skills folder. */
export function moveSkill(from, to, source, env = process.env) {
  const sourceId = sanitizeId(from)
  const targetId = sanitizeId(to)
  const root = path.resolve(personaDir(sourceId, env), 'skills')
  const resolved = path.resolve(String(source ?? ''))
  if (!resolved.startsWith(`${root}${path.sep}`)) return { ok: false, error: '路径不在该角色的技能目录里' }
  if (!existsSync(resolved)) return { ok: false, error: '找不到这个技能' }
  const destDir = path.join(personaDir(targetId, env), 'skills')
  const destination = path.join(destDir, path.basename(resolved))
  if (existsSync(destination)) return { ok: false, error: '目标角色已有同名技能' }
  try {
    mkdirSync(destDir, { recursive: true })
    renameSync(resolved, destination)
    return { ok: true, from: sourceId, to: targetId, path: destination }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
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

          if (req.method === 'GET' && route === '/turn') {
            const sessionId = String(url.searchParams.get('session') ?? '').trim()
            const after = Number(url.searchParams.get('after') ?? Number.NaN)
            const turn = Number(url.searchParams.get('turn') ?? Number.NaN)
            if (!sessionId) {
              send(res, 400, { error: '缺少 session' })
              return
            }
            const index = await readIndex(env)
            const matches = []
            for (const id of [UNCLAIMED_ID, ...index.personas.map((entry) => entry.id)]) {
              let text = ''
              try {
                text = await fs.readFile(path.join(personaDir(id, env), 'review', 'log.jsonl'), 'utf8')
              } catch {
                continue
              }
              for (const line of text.split(/\r?\n/)) {
                if (!line) continue
                let record
                try {
                  record = JSON.parse(line)
                } catch {
                  continue
                }
                if (record.sessionId !== sessionId) continue
                const byTurn = Number.isFinite(turn) && record.turn === turn
                // The review runs just before turn/end commits, so its seq can sit one behind.
                const bySeq = Number.isFinite(after) && Number.isFinite(record.seq) && record.seq >= after - 2
                if (!byTurn && !bySeq) continue
                matches.push({ ...record, persona: record.persona ?? id })
              }
            }
            matches.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
            send(res, 200, { turn: matches[0] ?? null })
            return
          }

          if (req.method === 'GET' && route === '/topics') {
            const id = sanitizeId(url.searchParams.get('id') ?? '')
            const index = await readIndex(env)
            const known = index.personas.some((entry) => entry.id === id) || id === UNCLAIMED_ID
            if (!known) {
              send(res, 400, { error: `没有这个角色：${id}` })
              return
            }
            const showExpired = String(url.searchParams.get('show') ?? '') === 'expired'
            const ttl = Number(config.topicTtlDays ?? 90)
            const all = listTopicsSync(id, env).filter((topic) => showExpired || !isTopicExpired(topic, ttl))
            const slug = String(url.searchParams.get('slug') ?? '').trim()
            if (slug) {
              const hit = all.find((topic) => topic.slug === slug)
              if (!hit) {
                send(res, 404, { error: `没有这个主题：${slug}` })
                return
              }
              send(res, 200, { id, topic: hit })
              return
            }
            const topics = all.map((topic) => ({
              slug: topic.slug,
              summary: topic.summary,
              chars: topic.chars,
              updated: topic.updated,
              path: topic.path,
            }))
            send(res, 200, { id, dir: topicsDir(id, env), topics })
            return
          }

          if (req.method === 'GET' && route === '/memory/history') {
            const id = sanitizeId(url.searchParams.get('id') ?? '')
            const index = await readIndex(env)
            const known = index.personas.some((entry) => entry.id === id) || id === UNCLAIMED_ID
            if (!known) {
              send(res, 400, { error: `没有这个角色：${id}` })
              return
            }
            const meta = readMetaSync(id, env)
            const today = new Date().toISOString().slice(0, 10)
            const records = Object.entries(meta.entries ?? {}).map(([hash, record]) => ({
              hash,
              ...record,
              expired: Boolean(record.expiresAt && String(record.expiresAt) < today),
            }))
            const show = String(url.searchParams.get('show') ?? '')
            const list = show === 'all'
              ? records
              : records.filter((record) => record.status !== 'active' || record.expired)
            send(res, 200, { id, count: list.length, entries: list })
            return
          }
          if (req.method === 'GET' && route === '/memory/stats') {
            const id = sanitizeId(url.searchParams.get('id') ?? '')
            const index = await readIndex(env)
            const known = index.personas.some((entry) => entry.id === id) || id === UNCLAIMED_ID
            if (!known) {
              send(res, 400, { error: `没有这个角色：${id}` })
              return
            }
            const limits = limitsForPersona(index, id)
            const resident = {}
            for (const target of ['user', 'memory']) {
              const entries = await readEntries(id, target, env)
              resident[target] = usage(entries, limits[target])
            }
            const topics = listTopicsSync(id, env)
            let rebuilt = false
            try {
              const manifestFile = path.join(personaDir(id, env), 'memory', 'index', 'manifest.json')
              const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
              const newest = topics.reduce((max, topic) => Math.max(max, Number(topic.chars)), 0)
              if (!manifest || manifest.count !== topics.length || manifest.builtAt === undefined) {
                await writeTopicManifest(id, env)
                rebuilt = true
              } else if (newest > 0 && Date.parse(manifest.builtAt) < Date.now() - 1000 * 60 * 60 * 24 * 7) {
                rebuilt = false
              }
            } catch {
              await writeTopicManifest(id, env)
              rebuilt = true
            }
            send(res, 200, { id, resident, topics: { count: topics.length, chars: topics.reduce((sum, topic) => sum + topic.chars, 0) }, drift: { rebuilt } })
            return
          }
          if (req.method === 'GET' && route === '/skills') {
            const id = sanitizeId(url.searchParams.get('id') ?? '')
            const index = await readIndex(env)
            const known = index.personas.some((entry) => entry.id === id) || id === UNCLAIMED_ID
            if (!known) {
              send(res, 400, { error: `没有这个角色：${id}` })
              return
            }
            send(res, 200, listSkills(id, env))
            return
          }

          if (req.method === 'GET' && route === '/resolve') {
            const index = await readIndex(env)
            const sessionId = String(url.searchParams.get('session') ?? '').trim()
            const cwd = url.searchParams.get('cwd') || (sessionId ? sessionCwd(sessionId, env) : null)
            const persona = resolvePersonaForCwd(index, cwd)
            send(res, 200, { persona: persona ?? null, cwd: cwd ?? null })
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

          if (req.method === 'POST' && route === '/index/rebuild') {
            const id = sanitizeId(body?.id ?? '')
            const index = await readIndex(env)
            const known = index.personas.some((entry) => entry.id === id) || id === UNCLAIMED_ID
            if (!known) {
              send(res, 400, { error: `没有这个角色：${id}` })
              return
            }
            const started = Date.now()
            const result = await writeTopicManifest(id, env)
            send(res, 200, { ok: true, id, ...result, ms: Date.now() - started })
            return
          }
          if (req.method === 'POST' && route === '/topics/archive') {
            const id = sanitizeId(body.id ?? '')
            const index = await readIndex(env)
            const known = index.personas.some((entry) => entry.id === id) || id === UNCLAIMED_ID
            if (!known) {
              send(res, 400, { error: `没有这个角色：${id}` })
              return
            }
            const archived = await archiveTopic(id, body.slug, env)
            if (!archived.ok) {
              send(res, 400, { error: archived.error })
              return
            }
            send(res, 200, { ok: true, ...archived })
            return
          }
          if (req.method === 'POST' && route === '/topics') {
            const id = sanitizeId(body.id ?? '')
            const index = await readIndex(env)
            const known = index.personas.some((entry) => entry.id === id) || id === UNCLAIMED_ID
            if (!known) {
              send(res, 400, { error: `没有这个角色：${id}` })
              return
            }
            const written = await writeTopic(id, { slug: body.slug, summary: body.summary, content: body.content }, env)
            if (!written.ok) {
              send(res, 400, { error: written.error })
              return
            }
            await writeTopicManifest(id, env).catch(() => {})
            send(res, 200, { ok: true, ...written })
            return
          }
          if (req.method === 'POST' && route === '/skills/move') {
            const from = sanitizeId(body.from ?? '')
            const to = sanitizeId(body.to ?? '')
            const known = new Set([...index.personas.map((entry) => entry.id), UNCLAIMED_ID])
            if (!known.has(from) || !known.has(to)) {
              send(res, 400, { error: '角色不存在' })
              return
            }
            if (from === to) {
              send(res, 400, { error: '不能移到同一个角色' })
              return
            }
            const moved = moveSkill(from, to, body.path, env)
            if (!moved.ok) {
              send(res, 400, { error: moved.error })
              return
            }
            send(res, 200, { ok: true, path: moved.path })
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
