/**
 * Pure helpers for Agent chat history: conversation titles, sidebar date
 * groups, and turning stored messages back into prompt context.
 */
import type { ContextTurn } from '@/lib/agent/chat'

export interface ConversationSummary {
  id: string
  title: string
  created_at: string
  updated_at: string
}

export interface StoredToolEntry {
  id: string
  name: string
  tier: 'read' | 'low' | 'high'
  status: 'running' | 'ok' | 'error' | 'awaiting'
  ms?: number
  error?: string
}

export interface StoredApproval {
  action_id: string
  deep_link: string
  summary: string | null
  tool: string
  /**
   * awaiting the owner's tap; approved by skip-permissions mode and run (or
   * failed); or claimed / run by someone else first (handled_elsewhere).
   */
  state?: 'awaiting' | 'auto_executed' | 'auto_failed' | 'handled_elsewhere'
}

export interface StoredMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  text: string
  tools: StoredToolEntry[]
  approvals: StoredApproval[]
  error: string | null
  run_id: string | null
  /** An automatic follow-up turn (an approval outcome), shown as a compact line, not a bubble. */
  auto: boolean
  created_at: string
}

export const TITLE_MAX = 60

/** First line of the first message, whitespace-collapsed, cut at a word near 60 chars. */
export function titleFromPrompt(prompt: string, max = TITLE_MAX): string {
  const line = prompt.trim().split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? ''
  if (!line) return 'New chat'
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export type HistoryGroup = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older'
const ORDER: HistoryGroup[] = ['Today', 'Yesterday', 'Previous 7 days', 'Older']

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Bucket by `updated_at` in the viewer's local time; empty groups are dropped, order kept. */
export function groupConversations<T extends { updated_at: string }>(
  list: T[],
  now = new Date()
): { label: HistoryGroup; items: T[] }[] {
  const today = startOfDay(now)
  const day = 86_400_000
  const buckets = new Map<HistoryGroup, T[]>(ORDER.map((g) => [g, []]))
  for (const c of list) {
    const t = new Date(c.updated_at).getTime()
    const g: HistoryGroup = t >= today ? 'Today' : t >= today - day ? 'Yesterday' : t >= today - 7 * day ? 'Previous 7 days' : 'Older'
    buckets.get(g)!.push(c)
  }
  return ORDER.filter((g) => buckets.get(g)!.length).map((label) => ({ label, items: buckets.get(label)! }))
}

/** Stored turns → `buildPrompt` context. Errored, empty assistant turns are left out. */
export function contextFromMessages(messages: Pick<StoredMessage, 'role' | 'text'>[]): ContextTurn[] {
  return messages.filter((m) => m.role === 'user' || m.text.trim()).map((m) => ({ role: m.role, text: m.text }))
}
