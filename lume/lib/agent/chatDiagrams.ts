import { parseDiagram, type Diagram } from '@/lib/agent/diagram'

/** A ```flow block found in an assistant reply, for the Agent's pipeline panel. */
export interface ChatDiagram {
  /** `<messageId>:<n>` — n counts flow blocks within that message. */
  key: string
  messageId: string
  index: number
  /** Null while the block is still streaming. */
  diagram: Diagram | null
  streaming: boolean
}

/** Every flow block in reply order; invalid finished blocks are skipped (they render as code). */
export function chatDiagrams(messages: readonly { id: string; role: string; text: string }[]): ChatDiagram[] {
  const out: ChatDiagram[] = []
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.text.includes('```')) continue
    const lines = m.text.replace(/\r\n?/g, '\n').split('\n')
    let n = -1
    for (let i = 0; i < lines.length; i++) {
      const open = /^\s*```\s*([\w-]*)/.exec(lines[i])
      if (!open) continue
      const lang = open[1].toLowerCase()
      const body: string[] = []
      let j = i + 1
      while (j < lines.length && !/^\s*```/.test(lines[j])) body.push(lines[j++])
      const closed = j < lines.length
      i = j
      if (lang !== 'flow') continue
      n++
      if (!closed) {
        out.push({ key: `${m.id}:${n}`, messageId: m.id, index: n, diagram: null, streaming: true })
        continue
      }
      const d = parseDiagram(body.join('\n'))
      if (d.ok) out.push({ key: `${m.id}:${n}`, messageId: m.id, index: n, diagram: d.diagram, streaming: false })
    }
  }
  return out
}

/** Tool names whose completion changes the lead review set shown in the Leads tab. */
export const REVIEW_TOOLS = new Set(['load_actor_results', 'load_attachment_as_leads', 'filter_leads', 'restore_leads'])
