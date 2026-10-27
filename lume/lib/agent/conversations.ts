import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import type { ConversationSummary, StoredApproval, StoredMessage, StoredToolEntry } from '@/lib/agent/history'
import { maskOperatorKeys } from '@/lib/operators/mask'

/** `agent_conversations` / `agent_messages` (service role, after the owner guard). */

const COLS = 'id, title, created_at, updated_at'

/**
 * A Grok Bot's chats carry its vertical (null for the master bot) and
 * operator; an owner chat opened from a vertical's /operator page carries the
 * vertical only.
 */
export interface ConversationOrigin {
  vertical_id: string | null
  operator_id: string | null
}

export async function createConversation(title: string, origin?: ConversationOrigin): Promise<ConversationSummary> {
  const sb = createServiceClient()
  const safeTitle = maskOperatorKeys(title)
  const row: Record<string, string | null> = origin
    ? { title: safeTitle, vertical_id: origin.vertical_id, operator_id: origin.operator_id }
    : { title: safeTitle }
  const res = await sb.from('agent_conversations').insert(row).select(COLS).single()
  if (res.error || !res.data) throw new DbError('createConversation', res.error ?? new Error('no data'))
  return res.data as ConversationSummary
}

/** A live (not archived) conversation, or null. */
export async function getConversation(id: string): Promise<ConversationSummary | null> {
  const sb = createServiceClient()
  const res = await sb.from('agent_conversations').select(COLS).eq('id', id).is('archived_at', null).maybeSingle()
  if (res.error) throw new DbError('getConversation', res.error)
  return (res.data as ConversationSummary | null) ?? null
}

export async function listConversations(limit = 100): Promise<ConversationSummary[]> {
  const sb = createServiceClient()
  const res = await sb.from('agent_conversations').select(COLS).is('archived_at', null).order('updated_at', { ascending: false }).limit(limit)
  if (res.error) throw new DbError('listConversations', res.error)
  return (res.data ?? []) as ConversationSummary[]
}

export async function getMessages(conversationId: string): Promise<StoredMessage[]> {
  const sb = createServiceClient()
  const res = await sb
    .from('agent_messages')
    .select('id, conversation_id, role, text, tools, approvals, error, run_id, auto, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(500)
  if (res.error) throw new DbError('getMessages', res.error)
  return (res.data ?? []) as StoredMessage[]
}

export interface NewMessage {
  conversation_id: string
  role: 'user' | 'assistant'
  text: string
  tools?: StoredToolEntry[]
  approvals?: StoredApproval[]
  error?: string | null
  run_id?: string | null
  /** An automatic follow-up turn (defaults to false). */
  auto?: boolean
}

/** Insert a message and bump the conversation's `updated_at` (sidebar order). */
export async function insertMessage(m: NewMessage): Promise<void> {
  const sb = createServiceClient()
  // A sign-in link the agent was handed once (issue_operator_key) is stored masked only.
  const res = await sb.from('agent_messages').insert({
    conversation_id: m.conversation_id,
    role: m.role,
    text: maskOperatorKeys(m.text),
    tools: maskOperatorKeys(m.tools ?? []) as unknown as Json,
    approvals: maskOperatorKeys(m.approvals ?? []) as unknown as Json,
    error: m.error ? maskOperatorKeys(m.error) : null,
    run_id: m.run_id ?? null,
    auto: m.auto ?? false,
  })
  if (res.error) throw new DbError('insertMessage', res.error)
  const touch = await sb.from('agent_conversations').update({ updated_at: new Date().toISOString() }).eq('id', m.conversation_id)
  if (touch.error) throw new DbError('insertMessage.touch', touch.error)
}

/** Rename; false when the conversation does not exist or is archived. */
export async function renameConversation(id: string, title: string): Promise<boolean> {
  const sb = createServiceClient()
  const res = await sb.from('agent_conversations').update({ title }).eq('id', id).is('archived_at', null).select('id')
  if (res.error) throw new DbError('renameConversation', res.error)
  return (res.data ?? []).length > 0
}

/** Soft delete; false when already gone. */
export async function archiveConversation(id: string): Promise<boolean> {
  const sb = createServiceClient()
  const res = await sb.from('agent_conversations').update({ archived_at: new Date().toISOString() }).eq('id', id).is('archived_at', null).select('id')
  if (res.error) throw new DbError('archiveConversation', res.error)
  return (res.data ?? []).length > 0
}
