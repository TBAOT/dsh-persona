/**
 * Per-persona memory policy: what the agent may write, and how big things may get.
 *
 * Modelled on Letta's `.memfs.config.json`: the rules live in a tracked file that is
 * **owned by the human** — the plugin never writes it, the panel is the only writer,
 * and every write path passes through one gate (`assertWritable`). Letta enforces the
 * same thing inside a git pre-commit validator and gates changes to the file behind
 * an env var only a human sets; we have no git, so the file itself is the contract.
 *
 * A missing or unreadable policy means the defaults, never a failure: memory has to
 * keep working even when its rules file is broken.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { personaDir } from './store.js'

export const POLICY_VERSION = 1
/** Tiers that can be marked read-only. `topic` covers the whole topic library. */
export const POLICY_TARGETS = ['user', 'memory', 'topic']

export const DEFAULT_POLICY = Object.freeze({
  version: POLICY_VERSION,
  readOnly: [],
  entryMaxChars: 120,
  topicMaxChars: 4000,
  limits: null,
})

export function policyFile(persona, env = process.env) {
  return path.join(personaDir(persona, env), 'memory', 'policy.json')
}

/**
 * Read the policy for one persona.
 * @returns {{ policy: typeof DEFAULT_POLICY, warning: string | null, path: string, present: boolean }}
 */
export function readPolicySync(persona, env = process.env) {
  const file = policyFile(persona, env)
  if (!existsSync(file)) return { policy: { ...DEFAULT_POLICY }, warning: null, path: file, present: false }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return {
      policy: { ...DEFAULT_POLICY },
      warning: `policy.json 不是合法 JSON，已按默认值处理：${error instanceof Error ? error.message : String(error)}`,
      path: file,
      present: true,
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { policy: { ...DEFAULT_POLICY }, warning: 'policy.json 必须是对象，已按默认值处理', path: file, present: true }
  }
  const readOnly = Array.isArray(parsed.readOnly)
    ? parsed.readOnly.map((item) => String(item)).filter((item) => POLICY_TARGETS.includes(item))
    : []
  const entryMaxChars = Number.isSafeInteger(parsed.entryMaxChars) && parsed.entryMaxChars > 0
    ? parsed.entryMaxChars
    : DEFAULT_POLICY.entryMaxChars
  const topicMaxChars = Number.isSafeInteger(parsed.topicMaxChars) && parsed.topicMaxChars > 0
    ? parsed.topicMaxChars
    : DEFAULT_POLICY.topicMaxChars
  const limits = parsed.limits && typeof parsed.limits === 'object'
    ? {
        user: Number.isSafeInteger(parsed.limits.user) && parsed.limits.user > 0 ? parsed.limits.user : null,
        memory: Number.isSafeInteger(parsed.limits.memory) && parsed.limits.memory > 0 ? parsed.limits.memory : null,
      }
    : null
  return {
    policy: { version: POLICY_VERSION, readOnly, entryMaxChars, topicMaxChars, limits },
    warning: null,
    path: file,
    present: true,
  }
}

/** Is this tier (or the topic library) closed to the agent? */
export function isReadOnly(policy, target) {
  return Array.isArray(policy?.readOnly) && policy.readOnly.includes(String(target))
}

/**
 * The one gate every write path must pass before touching disk.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function assertWritable(persona, target, env = process.env) {
  const { policy } = readPolicySync(persona, env)
  if (!isReadOnly(policy, target)) return { ok: true }
  const label = target === 'topic' ? '主题库' : `${target} 档`
  return { ok: false, error: `${label}已设为只读：只有人能在面板解锁后修改（policy.json 的 readOnly）` }
}

/** Persona limits with the policy taking precedence over the roster values. */
export function effectiveLimits(policy, fallback = {}) {
  return {
    user: Number(policy?.limits?.user ?? fallback.user),
    memory: Number(policy?.limits?.memory ?? fallback.memory),
  }
}
