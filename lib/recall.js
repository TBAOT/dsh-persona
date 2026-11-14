/**
 * Recall: pick the few topic summaries worth putting in front of the model this
 * turn. Deliberately keyword-only — with a dozen topics a vector index would be
 * more machinery than signal — and deliberately separate from the prompt index,
 * which is fixed at session start.
 *
 * The scoring is the same one `scripts/probe.mjs` measures, so what the probe
 * reports is what the live path actually does.
 */

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
 * A short block listing the best candidates. Returns '' when nothing scores or
 * the budget cannot fit even one line — then the turn simply runs without recall.
 */
export function buildRecallBlock(query, topics, options = {}) {
  const topN = Number(options.topN ?? 3)
  const budget = Number(options.budget ?? 400)
  if (topN <= 0 || budget <= 0 || isTrivialPrompt(query)) return ''
  const ranked = rankTopics(query, topics, topN)
  if (!ranked.length) return ''
  const header = '可能相关的主题（需要细节再按 slug 读 topics/<slug>.md）：'
  const lines = []
  let used = header.length + 1
  for (const { topic } of ranked) {
    const line = `- ${topic.slug}｜${String(topic.summary ?? '').replace(/\s+/g, ' ').slice(0, 30)}`
    if (used + line.length + 1 > budget) break
    lines.push(line)
    used += line.length + 1
  }
  if (!lines.length) return ''
  return `${header}\n${lines.join('\n')}`
}

/**
 * Append the recall block to the turn's last user message. Written against the
 * shapes a pre-step payload may take, and returning false when nothing matched
 * so a wrong guess degrades to "no recall" instead of breaking the turn.
 */
export function applyRecall(step, block) {
  if (!block || !step || typeof step !== 'object') return false
  const lists = [step.messages, step.input?.messages, step.request?.messages].filter(Array.isArray)
  for (const messages of lists) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (!message || message.role !== 'user') continue
      if (typeof message.content === 'string') {
        message.content = `${message.content}\n\n${block}`
        return true
      }
      if (Array.isArray(message.content)) {
        message.content = [...message.content, { type: 'text', text: block }]
        return true
      }
      return false
    }
  }
  return false
}
