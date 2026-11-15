/**
 * Recall: pick the few topic summaries worth putting in front of the model this
 * turn. Deliberately keyword-only — with a dozen topics a vector index would be
 * more machinery than signal — and deliberately separate from the prompt index,
 * which is fixed at session start.
 *
 * The scoring is the same one `scripts/probe.mjs` measures, so what the probe
 * reports is what the live path actually does.
 */

/**
 * Last recall outcome: what the turn actually cost, and — just as important —
 * why it cost nothing. A silent zero is how a dead recall path stayed invisible
 * for nine versions, so every early return records a reason.
 */
const EMPTY_RECALL = { outcome: 'disabled', chars: 0, topics: [], ms: 0, turn: null, error: null }
let lastRecall = { ...EMPTY_RECALL }

/**
 * Recall records by turn.
 *
 * The review of turn N can finish after the pre-step of turn N+1 has already
 * run — observed live on 2026-11-15. Keeping a short per-turn history lets the
 * review read *its own* turn instead of reporting whatever happened last.
 */
const RECALL_HISTORY = 16
const recallByTurn = new Map()

export function noteRecall(update) {
  const patch = typeof update === 'number' ? { chars: Number(update || 0) } : update ?? {}
  lastRecall = { ...lastRecall, ...patch, chars: Number(patch.chars ?? 0) }
  if (Number.isFinite(lastRecall.turn)) {
    recallByTurn.set(lastRecall.turn, { ...lastRecall })
    while (recallByTurn.size > RECALL_HISTORY) recallByTurn.delete(recallByTurn.keys().next().value)
  }
}

/** What recall did: for one turn when asked, otherwise for the most recent one. */
export function recallSummary(turn) {
  if (Number.isFinite(turn) && recallByTurn.has(turn)) return { ...recallByTurn.get(turn) }
  return { ...lastRecall }
}

/** Back-compat helper for callers that only need the injected size. */
export function recallChars() {
  return Number(lastRecall.chars ?? 0)
}

export function resetRecall() {
  lastRecall = { ...EMPTY_RECALL }
  recallByTurn.clear()
}

const TRIVIAL = /^(yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|continue|go ahead|do it|proceed|got it|cool|nice|great|done|next|lgtm|k|嗯|好|好的|行|可以|继续|收到|谢谢|对|是的|👍|👌)$/i

/** Bare acknowledgements and slash commands should not pay for a recall round. */
export function isTrivialPrompt(text) {
  const value = String(text ?? '').trim()
  if (!value) return true
  if (value.startsWith('/')) return true
  return TRIVIAL.test(value.replace(/[\s!?.,;:~()\[\]{}*&^%$#@+=`"'—–…、。，；：？！（）【】《》]+$/u, ''))
}

/** CJK as 2-grams, latin as words. */
export function tokens(text) {
  const set = new Set()
  for (const word of String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)) {
    if (/^[a-z0-9]+$/.test(word)) {
      set.add(word)
      continue
    }
    if (word.length <= 2) set.add(word)
    else for (let index = 0; index < word.length - 1; index += 1) set.add(word.slice(index, index + 2))
  }
  return set
}

function coverage(queryTokens, docTokens) {
  if (!queryTokens.size || !docTokens.size) return 0
  let shared = 0
  for (const token of queryTokens) if (docTokens.has(token)) shared += 1
  return (shared / queryTokens.size) * 0.75 + (shared / docTokens.size) * 0.25
}

/** The index line is what the model actually sees, so it carries 70% of the weight. */
export function score(query, topic) {
  const q = tokens(query)
  const head = coverage(q, tokens(`${topic.slug} ${topic.summary}`))
  const body = coverage(q, tokens(topic.body ?? ''))
  return head * 0.7 + body * 0.3
}

export function rankTopics(query, topics, topN = 3) {
  return (Array.isArray(topics) ? topics : [])
    .map((topic) => ({ topic, score: Number(score(query, topic).toFixed(3)) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, topN))
}

/**
 * Rank and render in one pass: the block the caller injects, plus which slugs
 * made it in and why it stopped. Returning the reason lets the caller record
 * "nothing matched" instead of "nothing happened".
 */
export function selectTopics(query, topics, options = {}) {
  const topN = Number(options.topN ?? 3)
  const budget = Number(options.budget ?? 400)
  if (topN <= 0 || budget <= 0) return { block: '', picks: [], reason: 'disabled' }
  if (isTrivialPrompt(query)) return { block: '', picks: [], reason: 'trivial' }
  const ranked = rankTopics(query, topics, topN)
  if (!ranked.length) return { block: '', picks: [], reason: 'no-match' }
  const header = '可能相关的主题（需要细节再按 slug 读 topics/<slug>.md）：'
  const lines = []
  const picks = []
  let used = header.length + 1
  for (const { topic } of ranked) {
    const line = `- ${topic.slug}｜${String(topic.summary ?? '').replace(/\s+/g, ' ').slice(0, 30)}`
    if (used + line.length + 1 > budget) break
    lines.push(line)
    picks.push(topic.slug)
    used += line.length + 1
  }
  if (!lines.length) return { block: '', picks: [], reason: 'over-budget' }
  return { block: `${header}\n${lines.join('\n')}`, picks, reason: 'matched' }
}

/** A short block listing the best candidates, or '' when nothing fits the budget. */
export function buildRecallBlock(query, topics, options = {}) {
  return selectTopics(query, topics, options).block
}

/**
 * Append the recall block to the last user message of a step's messages.
 *
 * Pure on purpose: the Host hands us `UserMessage` objects marked readonly, so
 * mutating `content` in place is a bet that the object happens to be mutable.
 * We build new messages and let the caller return a new pre-step decision.
 */
export function injectRecall(messages, block) {
  if (!block || !Array.isArray(messages)) return { messages, injected: false, chars: 0, reason: 'no-messages' }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    const content = message.content
    const next = [...messages]
    if (typeof content === 'string') {
      if (content.includes(block)) return { messages, injected: false, chars: 0, reason: 'already-present' }
      next[index] = { ...message, content: `${content}\n\n${block}` }
      return { messages: next, injected: true, chars: block.length, reason: 'injected' }
    }
    if (Array.isArray(content)) {
      if (content.some((part) => part && part.type === 'text' && part.text === block)) {
        return { messages, injected: false, chars: 0, reason: 'already-present' }
      }
      next[index] = { ...message, content: [...content, { type: 'text', text: block }] }
      return { messages: next, injected: true, chars: block.length, reason: 'injected' }
    }
    return { messages, injected: false, chars: 0, reason: 'unsupported-content' }
  }
  return { messages, injected: false, chars: 0, reason: 'no-user-message' }
}
