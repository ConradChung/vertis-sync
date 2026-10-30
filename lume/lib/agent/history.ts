import type { ReplyCard } from '@/lib/inbox/model'
/**
 * Pure helpers for Agent chat history: conversation titles, sidebar date
 * groups, and turning stored messages back into prompt context.
 */
import type { ContextTurn } from '@/lib/agent/chat'
import { ACCEPTED_IMAGE_TYPES, IMAGE_PATH_RE, type ChatImageRef } from '@/lib/agent/images'
import { fileRefsOf, type ChatFileRef } from '@/lib/agent/files'

export interface ConversationSummary {
  id: string
  title: string
  created_at: string
  updated_at: string
  /** The project it is filed in; null (or absent) = Unfiled. */
  project_id?: string | null
}

export interface StoredToolEntry {
  id: string
  name: string
  tier: 'read' | 'low' | 'high'
  status: 'running' | 'ok' | 'error' | 'awaiting'
  ms?: number
  error?: string
  /** Non-blocking notes on the call's result (e.g. SOP lint warnings), one per line. */
  warnings?: string[]
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
  /** The pending_actions row's live status, attached when a conversation loads (null: row gone). Never stored. */
  status?: string | null
  /** send_reply: the reply card as filed (lib/inbox/model.ts ReplyCard). */
  reply?: ReplyCard
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
  /**
   * What the owner attached (user turns only): image refs (no `kind`; bytes in
   * `agent-chat-images`) and spreadsheet refs (`kind: 'file'`; agent_chat_files).
   */
  attachments?: (ChatImageRef | ChatFileRef)[]
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

/** A stored `attachments` value, keeping only well-formed image references. */
export function attachmentsOf(raw: unknown): ChatImageRef[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (a): a is ChatImageRef =>
      !!a &&
      typeof a === 'object' &&
      typeof (a as ChatImageRef).path === 'string' &&
      IMAGE_PATH_RE.test((a as ChatImageRef).path) &&
      typeof (a as ChatImageRef).name === 'string' &&
      (ACCEPTED_IMAGE_TYPES as readonly string[]).includes((a as ChatImageRef).media_type)
  )
}

/** Stored turns → `buildMessages` context. Errored, empty assistant turns are left out. */
export function contextFromMessages(messages: (Pick<StoredMessage, 'role' | 'text'> & { attachments?: unknown })[]): ContextTurn[] {
  return messages
    .filter((m) => m.role === 'user' || m.text.trim())
    .map((m) => {
      const images = m.role === 'user' ? attachmentsOf(m.attachments) : []
      const files = m.role === 'user' ? fileRefsOf(m.attachments) : []
      return { role: m.role, text: m.text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) }
    })
}

/** A new chat's title: the text's first line, else its first spreadsheet's or image's name. */
export function titleFromMessage(text: string, images: Pick<ChatImageRef, 'name'>[], files: Pick<ChatFileRef, 'name'>[] = []): string {
  if (text.trim() || (!images.length && !files.length)) return titleFromPrompt(text)
  const more = images.length + files.length - 1
  const first = files.length ? `File: ${files[0].name}` : `Image: ${images[0].name}`
  return titleFromPrompt(`${first}${more > 0 ? ` +${more}` : ''}`)
}
