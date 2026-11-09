import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { Json, LumeTaskRow, TaskStatus } from '@/lib/db/types'

/**
 * `lume_tasks` (service role, after the owner / hook-secret guard).
 *
 * `updated_at` is written by the caller on content and status changes (it is
 * what the Linear push compares with `linear_synced_at`); the sync's own
 * writes (`setLinearResult`) leave it alone so they never re-trigger a push.
 */

const COLS =
  'id, title, notes, due_at, all_day, action_kind, action_payload, status, action_id, last_error, reminded_at, ' +
  'linear_issue_id, linear_identifier, linear_url, linear_synced_at, linear_error, created_by, conversation_id, created_at, updated_at, vertical_id'

const rows = (data: unknown) => (data ?? []) as unknown as LumeTaskRow[]

/** Tasks due in [from, to), soonest first. */
export async function listTasks(fromIso: string, toIso: string, limit = 500): Promise<LumeTaskRow[]> {
  const res = await createServiceClient()
    .from('lume_tasks')
    .select(COLS)
    .gte('due_at', fromIso)
    .lt('due_at', toIso)
    .order('due_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit)
  if (res.error) throw new DbError('listTasks', res.error)
  return rows(res.data)
}

export async function getTask(id: string): Promise<LumeTaskRow | null> {
  const res = await createServiceClient().from('lume_tasks').select(COLS).eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getTask', res.error)
  return (res.data as unknown as LumeTaskRow | null) ?? null
}

export interface TaskInsert {
  title: string
  notes: string | null
  due_at: string
  all_day: boolean
  action_kind: string | null
  action_payload: Record<string, Json> | null
  created_by: 'owner' | 'agent'
  conversation_id: string | null
}

export async function insertTask(row: TaskInsert): Promise<LumeTaskRow> {
  const res = await createServiceClient().from('lume_tasks').insert(row).select(COLS).single()
  if (res.error) throw new DbError('insertTask', res.error)
  return res.data as unknown as LumeTaskRow
}

export type TaskUpdate = Partial<
  Pick<LumeTaskRow, 'title' | 'notes' | 'due_at' | 'all_day' | 'status' | 'action_id' | 'last_error' | 'reminded_at'>
>

/**
 * Update a task (bumps `updated_at`). `onlyIf` makes it conditional on the
 * current status (a claim): null when no row matched.
 */
export async function updateTask(id: string, patch: TaskUpdate, onlyIf?: readonly TaskStatus[]): Promise<LumeTaskRow | null> {
  let q = createServiceClient()
    .from('lume_tasks')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (onlyIf) q = q.in('status', onlyIf as TaskStatus[])
  const res = await q.select(COLS).maybeSingle()
  if (res.error) throw new DbError('updateTask', res.error)
  return (res.data as unknown as LumeTaskRow | null) ?? null
}

/** Due, still scheduled, and not yet handled: action tasks, and plain tasks not yet reminded. */
export async function getDueTasks(nowIso: string, limit: number): Promise<LumeTaskRow[]> {
  const res = await createServiceClient()
    .from('lume_tasks')
    .select(COLS)
    .eq('status', 'scheduled')
    .lte('due_at', nowIso)
    .or('action_kind.not.is.null,reminded_at.is.null')
    .order('due_at', { ascending: true })
    .limit(limit)
  if (res.error) throw new DbError('getDueTasks', res.error)
  return rows(res.data)
}

/**
 * Claim a due action task: scheduled → awaiting_tap in one conditional
 * UPDATE, so two ticks never file the same action. False when another tick
 * (or an edit) got there first.
 */
export async function claimDueTask(id: string, nowIso: string): Promise<boolean> {
  const res = await createServiceClient()
    .from('lume_tasks')
    .update({ status: 'awaiting_tap', updated_at: nowIso })
    .eq('id', id)
    .eq('status', 'scheduled')
    .lte('due_at', nowIso)
    .not('action_kind', 'is', null)
    .select('id')
  if (res.error) throw new DbError('claimDueTask', res.error)
  return (res.data ?? []).length > 0
}

/** Claim a plain task's reminder: sets `reminded_at` once (status stays scheduled). */
export async function claimReminder(id: string, nowIso: string): Promise<boolean> {
  const res = await createServiceClient()
    .from('lume_tasks')
    .update({ reminded_at: nowIso })
    .eq('id', id)
    .eq('status', 'scheduled')
    .is('reminded_at', null)
    .is('action_kind', null)
    .select('id')
  if (res.error) throw new DbError('claimReminder', res.error)
  return (res.data ?? []).length > 0
}

/** Tasks whose filed action is still moving (awaiting_tap / running with an action). */
export async function getTasksWithOpenActions(limit: number): Promise<LumeTaskRow[]> {
  const res = await createServiceClient()
    .from('lume_tasks')
    .select(COLS)
    .in('status', ['awaiting_tap', 'running'])
    .not('action_id', 'is', null)
    .order('due_at', { ascending: true })
    .limit(limit)
  if (res.error) throw new DbError('getTasksWithOpenActions', res.error)
  return rows(res.data)
}

/** Open tasks with a Linear issue, least recently synced first. */
export async function getOpenLinkedTasks(limit: number): Promise<LumeTaskRow[]> {
  const res = await createServiceClient()
    .from('lume_tasks')
    .select(COLS)
    .in('status', ['scheduled', 'awaiting_tap', 'running'])
    .not('linear_issue_id', 'is', null)
    .order('linear_synced_at', { ascending: true, nullsFirst: true })
    .limit(limit)
  if (res.error) throw new DbError('getOpenLinkedTasks', res.error)
  return rows(res.data)
}

/**
 * Push candidates: never synced, or changed in the last 7 days (the caller
 * keeps those with `needsPush`; PostgREST cannot compare two columns).
 */
export async function getPushCandidates(sinceIso: string, limit: number): Promise<LumeTaskRow[]> {
  const res = await createServiceClient()
    .from('lume_tasks')
    .select(COLS)
    .or(`linear_synced_at.is.null,updated_at.gte.${sinceIso}`)
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (res.error) throw new DbError('getPushCandidates', res.error)
  return rows(res.data)
}

export type LinearResult =
  | { ok: true; issue_id: string; identifier: string; url: string; synced_at: string }
  | { ok: false; error: string }

/** Record a push outcome without touching `updated_at`. A failure keeps `linear_synced_at` as it was. */
export async function setLinearResult(id: string, r: LinearResult): Promise<void> {
  const patch = r.ok
    ? { linear_issue_id: r.issue_id, linear_identifier: r.identifier, linear_url: r.url, linear_synced_at: r.synced_at, linear_error: null }
    : { linear_error: r.error.slice(0, 1000) }
  const res = await createServiceClient().from('lume_tasks').update(patch).eq('id', id)
  if (res.error) throw new DbError('setLinearResult', res.error)
}

/** A change pulled from Linear: applied with `updated_at` = `linear_synced_at`, so it is not pushed back. */
export async function applyLinearPull(id: string, patch: TaskUpdate, atIso: string): Promise<void> {
  const res = await createServiceClient()
    .from('lume_tasks')
    .update({ ...patch, updated_at: atIso, linear_synced_at: atIso })
    .eq('id', id)
  if (res.error) throw new DbError('applyLinearPull', res.error)
}

/** The most recent Linear error on any task (the Calendar's banner). */
export async function lastLinearError(): Promise<{ error: string; at: string } | null> {
  const res = await createServiceClient()
    .from('lume_tasks')
    .select('linear_error, updated_at')
    .not('linear_error', 'is', null)
    .in('status', ['scheduled', 'awaiting_tap', 'running'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (res.error) throw new DbError('lastLinearError', res.error)
  const row = res.data as { linear_error: string; updated_at: string } | null
  return row ? { error: row.linear_error, at: row.updated_at } : null
}
