import 'server-only'
import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import { canonicalJson, type Diagram } from '@/lib/agent/diagram'
import type { NewDiagram, SavedDiagram } from '@/lib/playground/model'

/** `pipeline_diagrams` (service role, after the owner guard). Archived rows are invisible. */

const COLS = 'id, title, spec, source_conversation_id, created_at, updated_at'

export const specHash = (spec: Diagram) => createHash('sha256').update(canonicalJson(spec)).digest('hex')

export async function listDiagrams(limit = 100): Promise<SavedDiagram[]> {
  const sb = createServiceClient()
  const res = await sb.from('pipeline_diagrams').select(COLS).is('archived_at', null).order('updated_at', { ascending: false }).limit(limit)
  if (res.error) throw new DbError('listDiagrams', res.error)
  return (res.data ?? []) as unknown as SavedDiagram[]
}

export async function getDiagram(id: string): Promise<SavedDiagram | null> {
  const sb = createServiceClient()
  const res = await sb.from('pipeline_diagrams').select(COLS).eq('id', id).is('archived_at', null).maybeSingle()
  if (res.error) throw new DbError('getDiagram', res.error)
  return (res.data as unknown as SavedDiagram | null) ?? null
}

/**
 * Save a diagram, or return the live row with the identical spec (so "Open in
 * Playground" twice opens the same entry). `created` says which.
 */
export async function saveDiagram(d: NewDiagram): Promise<{ diagram: SavedDiagram; created: boolean }> {
  const sb = createServiceClient()
  const hash = specHash(d.spec)
  const existing = await sb.from('pipeline_diagrams').select(COLS).eq('spec_hash', hash).is('archived_at', null).maybeSingle()
  if (existing.error) throw new DbError('saveDiagram', existing.error)
  if (existing.data) return { diagram: existing.data as unknown as SavedDiagram, created: false }
  const res = await sb
    .from('pipeline_diagrams')
    .insert({
      title: d.title ?? d.spec.title ?? 'Untitled pipeline',
      spec: d.spec as unknown as Json,
      spec_hash: hash,
      source_conversation_id: d.source_conversation_id ?? null,
      source_message_id: d.source_message_id ?? null,
    })
    .select(COLS)
    .single()
  if (res.error) {
    // Lost a race with an identical save: return the winner.
    if (res.error.code === '23505') {
      const again = await sb.from('pipeline_diagrams').select(COLS).eq('spec_hash', hash).is('archived_at', null).maybeSingle()
      if (!again.error && again.data) return { diagram: again.data as unknown as SavedDiagram, created: false }
    }
    throw new DbError('saveDiagram', res.error)
  }
  return { diagram: res.data as unknown as SavedDiagram, created: true }
}

export async function renameDiagram(id: string, title: string): Promise<SavedDiagram | null> {
  const sb = createServiceClient()
  const res = await sb
    .from('pipeline_diagrams')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', id)
    .is('archived_at', null)
    .select(COLS)
    .maybeSingle()
  if (res.error) throw new DbError('renameDiagram', res.error)
  return (res.data as unknown as SavedDiagram | null) ?? null
}

export async function archiveDiagram(id: string): Promise<boolean> {
  const sb = createServiceClient()
  const res = await sb.from('pipeline_diagrams').update({ archived_at: new Date().toISOString() }).eq('id', id).is('archived_at', null).select('id')
  if (res.error) throw new DbError('archiveDiagram', res.error)
  return (res.data ?? []).length > 0
}
