import 'server-only'
import { maskOperatorKeys } from '@/lib/operators/mask'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import { knowledgeBlock, KNOWLEDGE_MAX_MEMORIES, KNOWLEDGE_MAX_TITLES, snippet, type Memory, type MemoryKind } from '@/lib/agent/memoryModel'

/** `agent_memory` and past-chat search (service role, behind the owner guard). */

const COLS = 'id, kind, content, source_conversation_id, created_at, updated_at'

export async function listMemories(limit = 200): Promise<Memory[]> {
  const res = await createServiceClient().from('agent_memory').select(COLS).is('archived_at', null).order('updated_at', { ascending: false }).limit(limit)
  if (res.error) throw new DbError('listMemories', res.error)
  return (res.data ?? []) as Memory[]
}

/** Saves a memory; the same text again just refreshes it. */
export async function addMemory(kind: MemoryKind, content: string, conversationId: string | null): Promise<{ memory: Memory; duplicate: boolean }> {
  const sb = createServiceClient()
  // Never remember an operator sign-in link in plaintext.
  const text = maskOperatorKeys(content.trim())
  const existing = await sb.from('agent_memory').select(COLS).is('archived_at', null).ilike('content', text.replace(/[%_\\]/g, (c) => `\\${c}`)).limit(1).maybeSingle()
  if (existing.error) throw new DbError('addMemory', existing.error)
  if (existing.data) {
    const upd = await sb.from('agent_memory').update({ updated_at: new Date().toISOString(), kind }).eq('id', existing.data.id).select(COLS).single()
    if (upd.error) throw new DbError('addMemory', upd.error)
    return { memory: upd.data as Memory, duplicate: true }
  }
  const res = await sb.from('agent_memory').insert({ kind, content: text, source_conversation_id: conversationId }).select(COLS).single()
  if (res.error) throw new DbError('addMemory', res.error)
  return { memory: res.data as Memory, duplicate: false }
}

export async function archiveMemory(id: string): Promise<boolean> {
  const res = await createServiceClient().from('agent_memory').update({ archived_at: new Date().toISOString() }).eq('id', id).is('archived_at', null).select('id')
  if (res.error) throw new DbError('archiveMemory', res.error)
  return (res.data ?? []).length > 0
}

/** The per-run "What Lume knows" block (empty string when there is nothing). */
export async function loadKnowledge(excludeConversationId?: string): Promise<string> {
  const sb = createServiceClient()
  const [mem, convs] = await Promise.all([
    sb.from('agent_memory').select('kind, content').is('archived_at', null).order('updated_at', { ascending: false }).limit(KNOWLEDGE_MAX_MEMORIES),
    sb.from('agent_conversations').select('id, title').is('archived_at', null).order('updated_at', { ascending: false }).limit(KNOWLEDGE_MAX_TITLES + 1),
  ])
  if (mem.error) throw new DbError('loadKnowledge', mem.error)
  if (convs.error) throw new DbError('loadKnowledge', convs.error)
  const titles = (convs.data ?? []).filter((c) => c.id !== excludeConversationId).map((c) => c.title as string)
  return knowledgeBlock((mem.data ?? []) as Pick<Memory, 'kind' | 'content'>[], titles)
}

export interface ChatHit {
  conversation_id: string
  title: string
  role: 'user' | 'assistant' | null
  snippet: string
  at: string
}

/** Case-insensitive search over past messages and conversation titles. */
export async function searchPastChats(query: string, limit = 12): Promise<ChatHit[]> {
  const sb = createServiceClient()
  const q = query.trim()
  const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
  const [msgs, titles] = await Promise.all([
    sb.from('agent_messages').select('conversation_id, role, text, created_at').ilike('text', pattern).order('created_at', { ascending: false }).limit(limit * 2),
    sb.from('agent_conversations').select('id, title, updated_at').is('archived_at', null).ilike('title', pattern).order('updated_at', { ascending: false }).limit(limit),
  ])
  if (msgs.error) throw new DbError('searchPastChats', msgs.error)
  if (titles.error) throw new DbError('searchPastChats', titles.error)
  const ids = [...new Set((msgs.data ?? []).map((m) => m.conversation_id as string))]
  const live = ids.length
    ? await sb.from('agent_conversations').select('id, title').in('id', ids).is('archived_at', null)
    : { data: [] as { id: string; title: string }[], error: null }
  if (live.error) throw new DbError('searchPastChats', live.error)
  const titleOf = new Map((live.data ?? []).map((c) => [c.id as string, c.title as string]))
  const hits: ChatHit[] = []
  const seen = new Set<string>()
  for (const t of titles.data ?? []) {
    hits.push({ conversation_id: t.id as string, title: t.title as string, role: null, snippet: t.title as string, at: t.updated_at as string })
  }
  for (const m of msgs.data ?? []) {
    const cid = m.conversation_id as string
    if (!titleOf.has(cid)) continue
    const key = `${cid}:${m.created_at}`
    if (seen.has(key)) continue
    seen.add(key)
    hits.push({ conversation_id: cid, title: titleOf.get(cid)!, role: m.role as 'user' | 'assistant', snippet: snippet(String(m.text ?? ''), q), at: m.created_at as string })
  }
  return hits.slice(0, limit)
}
