import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { TagRef, TagVertical } from '@/lib/tags/model'

/**
 * Reading and setting tags (service role, after the owner guard). A tag is a
 * row's `vertical_id`; the triggers carry it down to rows that inherited it
 * (a list's ingest and validation job, an action's task).
 */

export class UnknownTagError extends Error {
  constructor() {
    super('tag_not_found')
    this.name = 'UnknownTagError'
  }
}

/** Set (or clear, null) one row's tag. Null when the row does not exist. */
export async function setTag(ref: TagRef, verticalId: string | null): Promise<{ id: string; vertical_id: string | null; vertical_name: string | null } | null> {
  const sb = createServiceClient()
  let name: string | null = null
  if (verticalId) {
    const v = await sb.from('lume_verticals').select('id,name').eq('id', verticalId).is('archived_at', null).maybeSingle()
    if (v.error) throw new DbError('setTag.vertical', v.error)
    if (!v.data) throw new UnknownTagError()
    name = (v.data as TagVertical).name
  }
  const res = await sb.from(ref.table).update({ vertical_id: verticalId }).eq('id', ref.id).select('id,vertical_id').maybeSingle()
  if (res.error) throw new DbError('setTag', res.error)
  if (!res.data) return null
  return { ...(res.data as { id: string; vertical_id: string | null }), vertical_name: name }
}

/** Live verticals as tags (id + name), A→Z. */
export async function listTags(): Promise<TagVertical[]> {
  const res = await createServiceClient().from('lume_verticals').select('id,name').is('archived_at', null).order('name', { ascending: true })
  if (res.error) throw new DbError('listTags', res.error)
  return (res.data ?? []) as TagVertical[]
}

/** A chat's tag: its own vertical, else its project's (SQL lume_conversation_vertical). Null when untagged. */
export async function conversationTag(conversationId: string): Promise<TagVertical | null> {
  const sb = createServiceClient()
  const res = await sb.rpc('lume_conversation_vertical', { conv: conversationId })
  if (res.error) throw new DbError('conversationTag', res.error)
  const id = typeof res.data === 'string' ? res.data : null
  if (!id) return null
  const v = await sb.from('lume_verticals').select('id,name').eq('id', id).maybeSingle()
  if (v.error) throw new DbError('conversationTag.vertical', v.error)
  return (v.data as TagVertical | null) ?? null
}
