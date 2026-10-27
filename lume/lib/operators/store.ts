import 'server-only'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { Operator, Vertical, VerticalScope } from '@/lib/operators/types'

/**
 * `lume_verticals` / `lume_operators` (service role, after the owner guard).
 * An operator key is a sign-in link with full owner rights for one Grok Bot:
 * the raw key is returned once at creation and only its sha256 is stored.
 */

const VERTICAL_COLS = 'id, name, campaign_ids, scopes, is_default, created_at, archived_at'
const OPERATOR_COLS = 'id, vertical_id, is_master, label, created_at, revoked_at, last_seen_at'

/** A vertical with this name already exists (unique on name). */
export class DuplicateVerticalNameError extends Error {
  constructor(name: string) {
    super(`A vertical named "${name}" already exists`)
    this.name = 'DuplicateVerticalNameError'
  }
}

/** Another vertical already holds `is_default` (partial unique index `lume_verticals_one_default_idx`). */
export class DefaultVerticalConflictError extends Error {
  constructor() {
    super('Another vertical is already the default; unset it first')
    this.name = 'DefaultVerticalConflictError'
  }
}

type PgError = { code?: string; message?: string; details?: string } | null | undefined

/**
 * Map a unique violation to the constraint it hit: the name key → duplicate
 * name, the single-default index → default conflict. Anything else (or any
 * other error) returns undefined and the caller raises a DbError.
 */
function uniqueViolation(err: PgError, name: string): Error | undefined {
  if (err?.code !== '23505') return undefined
  const text = `${err.message ?? ''} ${err.details ?? ''}`
  if (text.includes('lume_verticals_one_default_idx')) return new DefaultVerticalConflictError()
  if (text.includes('lume_verticals_name_key')) return new DuplicateVerticalNameError(name)
  return undefined
}

const uniq = <T>(xs: T[]) => [...new Set(xs)]
const cleanIds = (ids: string[]) => uniq(ids.map((s) => s.trim()).filter(Boolean))

export async function listVerticals(opts: { includeArchived?: boolean } = {}): Promise<Vertical[]> {
  const sb = createServiceClient()
  let q = sb.from('lume_verticals').select(VERTICAL_COLS)
  if (!opts.includeArchived) q = q.is('archived_at', null)
  const res = await q.order('name', { ascending: true })
  if (res.error) throw new DbError('listVerticals', res.error)
  return (res.data ?? []) as Vertical[]
}

/** A vertical by id, archived or not. */
export async function getVertical(id: string): Promise<Vertical | null> {
  const sb = createServiceClient()
  const res = await sb.from('lume_verticals').select(VERTICAL_COLS).eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getVertical', res.error)
  return (res.data as Vertical | null) ?? null
}

export interface NewVertical {
  name: string
  scopes?: VerticalScope[]
  campaign_ids?: string[]
  is_default?: boolean
}

export async function createVertical(v: NewVertical): Promise<Vertical> {
  const sb = createServiceClient()
  const name = v.name.trim()
  const res = await sb
    .from('lume_verticals')
    .insert({
      name,
      scopes: uniq(v.scopes ?? []),
      campaign_ids: cleanIds(v.campaign_ids ?? []),
      is_default: v.is_default ?? false,
    })
    .select(VERTICAL_COLS)
    .single()
  const conflict = uniqueViolation(res.error, name)
  if (conflict) throw conflict
  if (res.error || !res.data) throw new DbError('createVertical', res.error ?? new Error('no data'))
  return res.data as Vertical
}

export type VerticalPatch = Partial<Pick<NewVertical, 'name' | 'scopes' | 'campaign_ids' | 'is_default'>>

/** Rename / re-scope / re-map a live vertical; null when missing or archived. */
export async function updateVertical(id: string, patch: VerticalPatch): Promise<Vertical | null> {
  const row: Record<string, unknown> = {}
  if (patch.name !== undefined) row.name = patch.name.trim()
  if (patch.scopes !== undefined) row.scopes = uniq(patch.scopes)
  if (patch.campaign_ids !== undefined) row.campaign_ids = cleanIds(patch.campaign_ids)
  if (patch.is_default !== undefined) row.is_default = patch.is_default
  const sb = createServiceClient()
  const res = await sb.from('lume_verticals').update(row).eq('id', id).is('archived_at', null).select(VERTICAL_COLS)
  const conflict = uniqueViolation(res.error, typeof row.name === 'string' ? row.name : '')
  if (conflict) throw conflict
  if (res.error) throw new DbError('updateVertical', res.error)
  return ((res.data ?? []) as Vertical[])[0] ?? null
}

/** Soft delete; false when already archived or missing. */
export async function archiveVertical(id: string): Promise<boolean> {
  const sb = createServiceClient()
  const res = await sb
    .from('lume_verticals')
    .update({ archived_at: new Date().toISOString(), is_default: false })
    .eq('id', id)
    .is('archived_at', null)
    .select('id')
  if (res.error) throw new DbError('archiveVertical', res.error)
  return (res.data ?? []).length > 0
}

/** sha256 hex of a raw operator key: what `lume_operators.key_hash` stores. */
export function hashOperatorKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export type OperatorKeyTarget = { verticalId: string; master?: false; label: string } | { master: true; verticalId?: undefined; label: string }

/** Mint a key: 32 random bytes, base64url. `rawKey` is returned this once and never stored. */
export async function createOperatorKey(target: OperatorKeyTarget): Promise<{ operator: Operator; rawKey: string }> {
  const rawKey = randomBytes(32).toString('base64url')
  const master = target.master === true
  const sb = createServiceClient()
  const res = await sb
    .from('lume_operators')
    .insert({
      vertical_id: master ? null : target.verticalId,
      is_master: master,
      label: target.label.trim(),
      key_hash: hashOperatorKey(rawKey),
    })
    .select(OPERATOR_COLS)
    .single()
  if (res.error || !res.data) throw new DbError('createOperatorKey', res.error ?? new Error('no data'))
  return { operator: res.data as Operator, rawKey }
}

/**
 * The live operator a raw key belongs to, or null (unknown, revoked, empty).
 * The lookup is by hash; the stored hash is then compared in constant time.
 */
export async function findOperatorByKey(raw: string | null | undefined): Promise<Operator | null> {
  if (!raw) return null
  const hash = hashOperatorKey(raw)
  const sb = createServiceClient()
  const res = await sb.from('lume_operators').select(`${OPERATOR_COLS}, key_hash`).eq('key_hash', hash).maybeSingle()
  if (res.error) throw new DbError('findOperatorByKey', res.error)
  const row = res.data as (Operator & { key_hash: string }) | null
  if (!row || typeof row.key_hash !== 'string') return null
  const a = Buffer.from(row.key_hash, 'hex')
  const b = Buffer.from(hash, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  if (row.revoked_at) return null
  const { key_hash: _omit, ...operator } = row
  void _omit
  return operator
}

/** Any operator by id, revoked or not (callers check `revoked_at`). */
export async function getOperator(id: string): Promise<Operator | null> {
  const sb = createServiceClient()
  const res = await sb.from('lume_operators').select(OPERATOR_COLS).eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getOperator', res.error)
  return (res.data as Operator | null) ?? null
}

/**
 * Revoke a key and sign its bot out: marks the key revoked, then deletes every
 * Supabase session its sign-ins recorded (`lume_revoke_operator_sessions`;
 * refresh tokens go with them), so the bot's owner session dies too. The
 * purge runs even when the key was already revoked, so a retry finishes a
 * half-done revoke. False when already revoked or missing.
 */
export async function revokeOperator(id: string): Promise<boolean> {
  const sb = createServiceClient()
  const res = await sb.from('lume_operators').update({ revoked_at: new Date().toISOString() }).eq('id', id).is('revoked_at', null).select('id')
  if (res.error) throw new DbError('revokeOperator', res.error)
  const purge = await sb.rpc('lume_revoke_operator_sessions', { op: id })
  if (purge.error) throw new DbError('revokeOperatorSessions', purge.error)
  return (res.data ?? []).length > 0
}

/** Record the Supabase session an operator sign-in minted, so revocation can delete it. */
export async function recordOperatorSession(operatorId: string, sessionId: string): Promise<void> {
  const sb = createServiceClient()
  const res = await sb.from('lume_operator_sessions').insert({ operator_id: operatorId, session_id: sessionId })
  if (res.error) throw new DbError('recordOperatorSession', res.error)
}

/** Record a check-in (`last_seen_at = now()`). */
export async function touchOperator(id: string): Promise<void> {
  const sb = createServiceClient()
  const res = await sb.from('lume_operators').update({ last_seen_at: new Date().toISOString() }).eq('id', id)
  if (res.error) throw new DbError('touchOperator', res.error)
}

/** Every key row (no hashes), newest first; `includeRevoked` keeps revoked ones for the settings list. */
export async function listOperators(opts: { includeRevoked?: boolean } = {}): Promise<Operator[]> {
  const sb = createServiceClient()
  let q = sb.from('lume_operators').select(OPERATOR_COLS)
  if (!opts.includeRevoked) q = q.is('revoked_at', null)
  const res = await q.order('created_at', { ascending: false })
  if (res.error) throw new DbError('listOperators', res.error)
  return (res.data ?? []) as Operator[]
}
