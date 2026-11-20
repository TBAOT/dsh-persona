/**
 * Host compatibility probe.
 *
 * The plugin declares `engines.dsh`, but a version range cannot tell us that a field
 * was renamed — and that is exactly how two silent breakages shipped: `TokenUsage` went
 * camelCase, `finish.reason` became an object. So instead of switching behaviour on a
 * version string, probe the seams we actually depend on, degrade where a fallback
 * exists, and say so where it does not.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Probed from the memory row, which injects `tools` + `systemPrompt` only. The LLM
// stream is the *review* row's seam (`inject: ['llm']`); probing it here reports a
// false "degraded" because `ctx.llm` is deliberately absent in this scope.
const FEATURES = [
  ['events', (ctx) => typeof ctx?.on === 'function', true],
  ['tools', (ctx) => typeof ctx?.tools?.register === 'function', true],
  ['promptSections', (ctx) => typeof ctx?.systemPrompt?.section === 'function', true],
  ['runtimeContext', (ctx) => typeof ctx?.systemPrompt?.context === 'function', false],
]

const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return null
  }
})()

let lastProbe = null

/** Inspect the live Host once at apply() time. */
export function probeHost(ctx) {
  const features = {}
  const missing = []
  const degraded = []
  for (const [name, test, required] of FEATURES) {
    let ok = false
    try {
      ok = Boolean(test(ctx))
    } catch {
      ok = false
    }
    features[name] = ok
    if (!ok) (required ? missing : degraded).push(name)
  }
  lastProbe = {
    at: new Date().toISOString(),
    features,
    missing,
    degraded,
    ok: missing.length === 0,
    // Without runtime context the recall block falls back to the older, dirtier path.
    recallMode: features.runtimeContext ? 'runtime-context' : 'user-message',
  }
  return lastProbe
}

export function compatStatus() {
  return lastProbe
}

/**
 * Merge the outcome of `apply()` into the probe: how long it took, and — when the plugin
 * disabled itself — why. Without this, "the app started but memory is gone" has no trace.
 */
export function recordApply({ ms, error } = {}) {
  if (!lastProbe) return null
  lastProbe = { ...lastProbe, applyMs: ms ?? null, lastError: error ? String(error) : null, nodeVersion: process.version }
  persistCompat(lastProbe)
  return lastProbe
}

/** Where the probe result lives so `pnpm health` (another process) can read it. */
export function compatFile(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'persona-compat.json')
}

export function persistCompat(probe, env = process.env) {
  const file = compatFile(env)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ ...probe, package: PACKAGE_VERSION }, null, 2)}\n`, 'utf8')
  } catch {
    /* diagnostics must never break the plugin */
  }
  return file
}

export function readCompatSync(env = process.env) {
  try {
    return JSON.parse(readFileSync(compatFile(env), 'utf8'))
  } catch {
    return null
  }
}

export function resetCompat() {
  lastProbe = null
}
