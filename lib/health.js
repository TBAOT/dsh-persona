/**
 * Live health of the memory pipeline, read straight from `metrics.jsonl`.
 *
 * Written because a dead recall path once shipped for nine versions while every
 * unit test stayed green: the only evidence that survives real traffic is this
 * file, so "is it working right now" has to be answerable in one command.
 */

// `skipped` means "this turn already injected, this step did not repeat it" — not a
// failure. Leaving it out made a healthy window look dead.
const SILENT_EXEMPT = new Set(['trivial', 'disabled', 'skipped'])

export function outcomeOf(row) {
  const explicit = row?.recall?.outcome
  if (typeof explicit === 'string' && explicit) return explicit
  // Older rows predate the `recall` object; a non-zero size still means it fired.
  return Number(row?.recallChars) > 0 ? 'injected' : 'unknown'
}

/**
 * Summarise the most recent turns.
 *
 * verdict:
 *   `broken`     — a row reports a shape/error failure (the injection never landed)
 *   `silent`     — nothing was injected in the window, though something should have been
 *   `unverified` — every row says `unknown`: the record cannot be attributed to a turn,
 *                  which is a metrics defect, not proof that recall is dead
 *   `ok`         — at least one turn injected a block
 *   `stale`      — newest row is older than `maxAgeDays` (an idle persona is not a fault)
 *   `empty`      — no usable rows
 */
export function summarizeMetrics(rows, options = {}) {
  const windowSize = Number(options.window ?? 5)
  const maxAgeDays = Number(options.maxAgeDays ?? 2)
  const today = options.today instanceof Date ? options.today : new Date()
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object')
  const recent = list.slice(-windowSize)

  const outcomes = {}
  for (const row of recent) {
    const outcome = outcomeOf(row)
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }
  const injected = recent.filter((row) => Number(row?.recall?.chars ?? row?.recallChars) > 0).length
  const tokens = recent.reduce(
    (acc, row) => {
      acc.in += Number(row?.tokens?.in ?? 0)
      acc.out += Number(row?.tokens?.out ?? 0)
      return acc
    },
    { in: 0, out: 0 },
  )
  const usageMissing = recent.filter((row) => row?.usageMissing).length
  const lastAt = recent.at(-1)?.at ?? null
  const ageDays = lastAt ? (today.getTime() - Date.parse(lastAt)) / 86400000 : Infinity

  const broken = recent.some((row) => ['unmatched-shape', 'error'].includes(outcomeOf(row)))
  const unverified = recent.length > 0 && injected === 0 && recent.every((row) => outcomeOf(row) === 'unknown')
  const silent =
    recent.length > 0 &&
    injected === 0 &&
    !unverified &&
    recent.some((row) => !SILENT_EXEMPT.has(outcomeOf(row)))

  const verdict = !recent.length
    ? 'empty'
    : Number.isFinite(ageDays) && ageDays > maxAgeDays
      ? 'stale'
      : broken
        ? 'broken'
        : silent
          ? 'silent'
          : unverified
            ? 'unverified'
            : 'ok'

  return {
    window: recent.length,
    outcomes,
    injected,
    tokens,
    usageMissing,
    tokenWarning: recent.length > 0 && usageMissing === recent.length,
    verdict,
    lastTurn: recent.at(-1)?.turn ?? null,
    lastAt,
  }
}

export function formatHealth(persona, summary) {
  const outcomes = Object.entries(summary.outcomes)
    .map(([name, count]) => `${name}×${count}`)
    .join(' ')
  const lines = [
    `[${persona}] 近 ${summary.window} 轮：注入 ${summary.injected} 次${outcomes ? `（${outcomes}）` : ''}`,
    `   tokens in/out：${summary.tokens.in}/${summary.tokens.out}${summary.tokenWarning ? '（全部缺 usage）' : ''}`,
    `   最近：turn ${summary.lastTurn ?? '?'} @ ${summary.lastAt ?? '?'} → ${summary.verdict}`,
  ]
  return lines.join('\n')
}
