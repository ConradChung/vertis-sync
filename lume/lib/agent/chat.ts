/**
 * Pure helpers for the Agent tab: SSE frame parsing for `/api/agent/run` and
 * packing earlier turns into the single `prompt` the route accepts.
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

/** `/api/agent/run` caps `prompt` at 4000 chars. */
export const PROMPT_MAX = 4000
const TURN_MAX = 600

/**
 * The route is stateless (one run per prompt), so earlier turns ride along as
 * clearly-labelled context ahead of the new message. Newest turns win when the
 * budget is tight; with no history the message is sent as-is.
 */
export function buildPrompt(history: ContextTurn[], message: string, max = PROMPT_MAX): string {
  const msg = message.trim().slice(0, max)
  const head = 'Earlier in this conversation (context only — do not repeat actions from it):\n'
  const tail = `\n\nCurrent request:\n${msg}`
  let budget = max - head.length - tail.length
  if (!history.length || budget < 80) return msg
  const lines: string[] = []
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]
    const text = t.text.trim().replace(/\s+/g, ' ')
    if (!text) continue
    const clipped = text.length > TURN_MAX ? `${text.slice(0, TURN_MAX)}…` : text
    const line = `${t.role === 'user' ? 'Owner' : 'Lume'}: ${clipped}`
    if (line.length + 1 > budget) break
    lines.unshift(line)
    budget -= line.length + 1
  }
  if (!lines.length) return msg
  return `${head}${lines.join('\n')}${tail}`
}
