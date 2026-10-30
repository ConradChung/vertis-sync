/**
 * Pure helpers for the Agent tab: SSE frame parsing for `/api/agent/run` and
 * replaying earlier turns as real turns for `/api/agent/run`.
 */

export type AgentEvent = Record<string, unknown> & { type: string }

/** Split a buffered SSE stream into parsed `data:` events and the unfinished tail. */
export function parseSseFrames(buffer: string): { events: AgentEvent[]; rest: string } {
  const events: AgentEvent[] = []
  let rest = buffer
  let idx: number
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const frame = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    const line = frame.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    try {
      const e = JSON.parse(line.slice(6)) as unknown
      if (e && typeof e === 'object' && typeof (e as AgentEvent).type === 'string') events.push(e as AgentEvent)
    } catch {
      // malformed frame: skip
    }
  }
  return { events, rest }
}

export interface ContextTurn {
  role: 'user' | 'assistant'
  text: string
}

/** `/api/agent/run` caps one owner message (pasted drafts, threads) at this many chars. */
export const MESSAGE_MAX = 50_000
/** Earlier turns sent with each run (~75k tokens); newest kept, oldest dropped. */
export const HISTORY_MAX_CHARS = 300_000
/** One stored turn longer than this is cut (so one giant paste can't push out the rest). */
export const TURN_MAX_CHARS = 40_000

export interface ChatTurnParam {
  role: 'user' | 'assistant'
  content: { type: 'text'; text: string }[]
}

const OMITTED = '[Earlier turns of this conversation were omitted for length.]'

/**
 * The route is stateless (one run per prompt), so the conversation's stored
 * turns are replayed as real user/assistant turns ahead of the current
 * message, in full up to TURN_MAX_CHARS each and HISTORY_MAX_CHARS in total
 * (newest win). Roles strictly alternate and start with the owner: same-role
 * neighbours merge, a leading assistant turn is dropped, and an unanswered
 * owner turn folds into the current message.
 */
export function buildMessages(history: ContextTurn[], message: string): ChatTurnParam[] {
  const current = message.trim()
  const kept: ContextTurn[] = []
  let budget = HISTORY_MAX_CHARS
  let omitted = false
  for (let i = history.length - 1; i >= 0; i--) {
    const raw = history[i].text.trim()
    if (!raw) continue
    const text = raw.length > TURN_MAX_CHARS ? `${raw.slice(0, TURN_MAX_CHARS)}\n… [truncated ${raw.length - TURN_MAX_CHARS} chars]` : raw
    if (text.length > budget) {
      omitted = true
      break
    }
    kept.unshift({ role: history[i].role, text })
    budget -= text.length
  }
  const merged: ContextTurn[] = []
  for (const t of kept) {
    const last = merged[merged.length - 1]
    if (last && last.role === t.role) last.text = `${last.text}\n\n${t.text}`
    else merged.push({ ...t })
  }
  while (merged.length && merged[0].role === 'assistant') {
    merged.shift()
    omitted = true
  }
  let tail = current
  if (merged.length && merged[merged.length - 1].role === 'user') tail = `${merged.pop()!.text}\n\n${current}`
  const turns: ContextTurn[] = [...merged, { role: 'user', text: tail }]
  if (omitted) turns[0] = { role: 'user', text: `${OMITTED}\n\n${turns[0].text}` }
  return turns.map((t) => ({ role: t.role, content: [{ type: 'text', text: t.text }] }))
}
