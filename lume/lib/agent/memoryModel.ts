import { z } from 'zod'

/** Cross-conversation memory: shapes and the compact "What Lume knows" block. Pure. */

export const MEMORY_KINDS = ['preference', 'fact', 'client', 'decision'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export interface Memory {
  id: string
  kind: MemoryKind
  content: string
  source_conversation_id: string | null
  created_at: string
  updated_at: string
}

export const newMemorySchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  content: z.string().trim().min(3).max(500),
})

export const KNOWLEDGE_MAX_CHARS = 2500
export const KNOWLEDGE_MAX_MEMORIES = 40
export const KNOWLEDGE_MAX_TITLES = 10

/**
 * Per-run context for the user turn (never the system prompt, which stays
 * cached): the newest memories first until the char budget is spent, then
 * recent conversation titles.
 */
export function knowledgeBlock(memories: readonly Pick<Memory, 'kind' | 'content'>[], titles: readonly string[], max = KNOWLEDGE_MAX_CHARS): string {
  if (!memories.length && !titles.length) return ''
  const head = 'What Lume knows (saved from earlier chats; use as context, it may be out of date — check live data before acting):'
  const lines: string[] = [head]
  let used = head.length
  for (const m of memories.slice(0, KNOWLEDGE_MAX_MEMORIES)) {
    const line = `- [${m.kind}] ${m.content.replace(/\s+/g, ' ').trim()}`
    if (used + line.length + 1 > max) break
    lines.push(line)
    used += line.length + 1
  }
  const recent = titles.slice(0, KNOWLEDGE_MAX_TITLES).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (recent.length) {
    const line = `Recent chats: ${recent.map((t) => `“${t}”`).join(', ')}`
    if (used + line.length + 1 <= max + 400) lines.push(line)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

/** A short window of text around the first match, for search results. */
export function snippet(text: string, needle: string, radius = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const i = flat.toLowerCase().indexOf(needle.toLowerCase())
  if (i < 0) return flat.slice(0, radius * 2)
  const start = Math.max(0, i - radius)
  const end = Math.min(flat.length, i + needle.length + radius)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** The model's user turn: knowledge block (if any) ahead of the packed prompt. */
export function withKnowledge(knowledge: string, prompt: string): string {
  return knowledge ? `${knowledge}\n\n${prompt}` : prompt
}
