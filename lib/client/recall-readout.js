/**
 * The footer readout for one turn's recall, as plain data.
 *
 * Kept out of the React component so the phrasing can be tested without a DOM —
 * and so the "quiet ledger cell, detail in the tooltip" rule lives in one place
 * instead of being re-decided inside JSX.
 */

const ALARM = new Set(['broken', 'silent'])
const OUTCOME_TEXT = {
  injected: '已注入',
  'no-match': '本轮无命中',
  trivial: '寒暄轮，跳过',
  skipped: '一步里已注入过',
  'no-topics': '主题库为空',
  'over-budget': '预算装不下',
  'unmatched-shape': '注入形状不符，没落地',
  error: '注入报错，已跳过',
  disabled: '召回关闭',
  unknown: '未记录到轮次',
}

/** @returns {{ label: string, title: string, tone: 'warn' | undefined }} */
export function recallReadout(health) {
  const empty = { label: '', title: '', tone: undefined }
  if (!health || typeof health !== 'object') return empty
  const last = health.last ?? null
  const recall = last?.recall ?? null
  const chars = Number(recall?.chars ?? 0)
  const slugs = Array.isArray(recall?.topics) ? recall.topics : []

  const label = chars > 0 ? `召回 ${slugs.length} 篇 / ${chars} 字符` : '召回 —'
  const outcome = recall?.outcome ?? 'unknown'
  const title = [
    `最近一轮 ${last?.at ?? '时间未知'}（turn ${last?.turn ?? '?'}）`,
    `结果 ${OUTCOME_TEXT[outcome] ?? outcome}${recall?.ms ? ` · ${Math.round(recall.ms)}ms` : ''}`,
    slugs.length ? `注入 ${slugs.join('、')}` : '本轮没有注入主题',
    `近 ${health.window ?? '?'} 轮注入 ${health.injected ?? 0} 次`,
  ].join('\n')
  return { label, title, tone: ALARM.has(String(health.verdict)) ? 'warn' : undefined }
}
