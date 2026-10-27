import 'server-only'
import { maskOperatorKeys } from '@/lib/operators/mask'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import type { NewSkill, Skill } from '@/lib/agent/skillModel'

/** `agent_skills` (service role, after the owner guard). Archived skills are invisible. */

const COLS = 'id, name, description, steps, variables, source_conversation_id, created_at, updated_at, last_run_at, run_count'

/** A live skill with this name already exists (unique index on lower(btrim(name))). */
export class DuplicateSkillNameError extends Error {
  constructor(name: string) {
    super(`A skill named "${name}" already exists`)
    this.name = 'DuplicateSkillNameError'
  }
}

export async function listSkills(limit = 100): Promise<Skill[]> {
  const sb = createServiceClient()
  const res = await sb.from('agent_skills').select(COLS).is('archived_at', null).order('updated_at', { ascending: false }).limit(limit)
  if (res.error) throw new DbError('listSkills', res.error)
  return (res.data ?? []) as Skill[]
}

export async function getSkill(id: string): Promise<Skill | null> {
  const sb = createServiceClient()
  const res = await sb.from('agent_skills').select(COLS).eq('id', id).is('archived_at', null).maybeSingle()
  if (res.error) throw new DbError('getSkill', res.error)
  return (res.data as Skill | null) ?? null
}

/** Case-insensitive name lookup, for "run my roofing skill". */
export async function findSkillByName(name: string): Promise<Skill | null> {
  const sb = createServiceClient()
  const res = await sb.from('agent_skills').select(COLS).is('archived_at', null).ilike('name', name.trim().replace(/[%_\\]/g, '\\$&')).limit(1)
  if (res.error) throw new DbError('findSkillByName', res.error)
  return ((res.data ?? [])[0] as Skill | undefined) ?? null
}

export async function createSkill(skill: NewSkill): Promise<Skill> {
  const sb = createServiceClient()
  const res = await sb
    .from('agent_skills')
    // An operator sign-in link is never stored in plaintext (lib/operators/mask.ts).
    .insert({
      name: maskOperatorKeys(skill.name),
      description: maskOperatorKeys(skill.description),
      steps: maskOperatorKeys(skill.steps) as unknown as Json,
      variables: maskOperatorKeys(skill.variables) as unknown as Json,
      source_conversation_id: skill.source_conversation_id ?? null,
    })
    .select(COLS)
    .single()
  if (res.error?.code === '23505') throw new DuplicateSkillNameError(skill.name)
  if (res.error || !res.data) throw new DbError('createSkill', res.error ?? new Error('no data'))
  return res.data as Skill
}

/** Rename / re-describe; null when missing or archived. */
export async function updateSkill(id: string, patch: { name?: string; description?: string }): Promise<Skill | null> {
  const sb = createServiceClient()
  const res = await sb
    .from('agent_skills')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .is('archived_at', null)
    .select(COLS)
  if (res.error?.code === '23505') throw new DuplicateSkillNameError(patch.name ?? '')
  if (res.error) throw new DbError('updateSkill', res.error)
  return ((res.data ?? [])[0] as Skill | undefined) ?? null
}

/** Soft delete; false when already gone. */
export async function archiveSkill(id: string): Promise<boolean> {
  const sb = createServiceClient()
  const res = await sb.from('agent_skills').update({ archived_at: new Date().toISOString() }).eq('id', id).is('archived_at', null).select('id')
  if (res.error) throw new DbError('archiveSkill', res.error)
  return (res.data ?? []).length > 0
}

/** run_count + 1, last_run_at = now() (atomic, in SQL). */
export async function markSkillRun(id: string): Promise<void> {
  const sb = createServiceClient()
  const res = await sb.rpc('agent_skill_mark_run', { p_id: id })
  if (res.error) throw new DbError('markSkillRun', res.error)
}
