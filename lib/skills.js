/**
 * dsh-persona — persona-private skills (Host half).
 *
 * A persona may own skills that no other persona should see. The platform's
 * skill roots are global, and a bundle patch cannot compute a per-user absolute
 * path, so this plugin does the discovery itself: it reads `<persona>/skills/`
 * and injects an index of those skills into that persona's prompt only.
 *
 * The bodies stay on disk; the prompt carries name, description and the exact
 * file path, so the agent reads the file when it decides the skill applies.
 * Nothing is registered globally, which is what keeps other personas blind.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { personaDir, sanitizeId } from './store.js'
import { readIndexSync, resolvePersonaForCwd } from './roster.js'

export const name = 'persona-skills'
export const inject = ['systemPrompt']

const HEADER = '## 本角色私有技能'

/** Parse the tiny YAML frontmatter block used by SKILL.md. */
export function parseFrontmatter(text) {
  const source = String(text ?? '')
  if (!source.startsWith('---')) return { meta: {}, body: source }
  const end = source.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: source }
  const head = source.slice(3, end)
  const body = source.slice(end + 4)
  const meta = {}
  for (const line of head.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    meta[key] = value
  }
  return { meta, body }
}

async function listSkillFiles(dir) {
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const candidate = path.join(dir, entry.name, 'SKILL.md')
      try {
        await fs.access(candidate)
        files.push(candidate)
      } catch {
        /* no SKILL.md */
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(path.join(dir, entry.name))
    }
  }
  return files.sort()
}

/** Read one persona's private skills as prompt-ready entries. */
export async function readPersonaSkills(personaId, env = process.env) {
  const dir = path.join(personaDir(personaId, env), 'skills')
  const files = await listSkillFiles(dir)
  const skills = []
  for (const file of files) {
    let text = ''
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    const entry = describeSkill(file, text)
    if (entry) skills.push(entry)
  }
  return skills
}

function listSkillFilesSync(dir) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const candidate = path.join(dir, entry.name, 'SKILL.md')
      if (existsSync(candidate)) files.push(candidate)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(path.join(dir, entry.name))
    }
  }
  return files.sort()
}

/** Synchronous variant, for prompt assembly (which cannot await). */
export function readPersonaSkillsSync(personaId, env = process.env) {
  const dir = path.join(personaDir(personaId, env), 'skills')
  const skills = []
  for (const file of listSkillFilesSync(dir)) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const entry = describeSkill(file, text)
    if (entry) skills.push(entry)
  }
  return skills
}

function describeSkill(file, text) {
  const { meta } = parseFrontmatter(text)
  const fallbackName =
    path.basename(path.dirname(file)) === 'skills' ? path.basename(file, '.md') : path.basename(path.dirname(file))
  const name = String(meta.name ?? fallbackName).trim()
  if (!name) return undefined
  return {
    name,
    description: String(meta.description ?? '').trim(),
    whenToUse: String(meta.whenToUse ?? '').trim(),
    path: file,
  }
}

/** Render the index block; empty string when the persona owns nothing. */
export function renderSkillIndex(skills) {
  if (!skills.length) return ''
  const rows = skills.map((skill) => {
    const when = skill.whenToUse ? `（何时用：${skill.whenToUse}）` : ''
    const desc = skill.description ? ` — ${skill.description}` : ''
    return `- \`${skill.name}\`${desc}${when}\n  完整说明：${skill.path}`
  })
  return [HEADER, '', '这些技能只属于当前角色。需要时用文件工具读取上面的路径。', '', ...rows].join('\n')
}

export function apply(ctx, config = {}) {
  const fallbackPersona = sanitizeId(config.personaId ?? 'default')
  const enabled = config.enabled !== false
  if (!enabled) return { disabled: true }

  /** agent id → rendered block, built synchronously on first assembly and then frozen. */
  const blocks = new Map()

  const blockOf = (agent) => {
    if (!agent?.id) return ''
    if (blocks.has(agent.id)) return blocks.get(agent.id)
    let persona = fallbackPersona
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd) {
      const hit = resolvePersonaForCwd(readIndexSync(process.env), cwd)
      if (hit) persona = hit.id
    }
    let block = ''
    try {
      block = renderSkillIndex(readPersonaSkillsSync(persona))
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-persona] 读取私有技能失败：${error instanceof Error ? error.message : String(error)}`)
    }
    blocks.set(agent.id, block)
    return block
  }

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id) blocks.delete(agent.id)
  })

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'persona:skills',
      order: 0.63,
      text: (assembly) => blockOf(assembly?.agent),
    }),
  )

  return { personaId: fallbackPersona }
}
