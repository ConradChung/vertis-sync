import 'server-only'
import { DbError } from '@/lib/db/service'
import { readIcp, releaseOf, SKIP_UNDER_MIN_UNITS, type Icp } from '@/lib/signals/icp'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Release a LinkedIn signal person the ICP gate held (stage 'held', units
 * unknown) with the unit count the owner typed. 500+ (signal_config.icp
 * .min_units) puts them back on the filter at 'contacts', so the next tick
 * finds the email, drafts and readies the Slack card as for anyone else;
 * under the minimum skips them ('under_min_units'). Conditional on the row
 * still being held, so nothing alerted or decided is touched.
 */

export async function getIcp(): Promise<Icp> {
  const res = await createServiceClient().from('lume_settings').select('value').eq('key', 'signal_config').maybeSingle()
  if (res.error) throw new DbError('signals.getIcp', res.error)
  const cfg = (res.data as { value?: Record<string, unknown> } | null)?.value
  return readIcp(cfg && typeof cfg === 'object' ? cfg.icp : undefined)
}

export type ReleaseResult = { ok: true; outcome: 'continue' | 'skip'; min_units: number } | { ok: false; error: 'not_held' }

export async function releaseHeld(personId: number, units: number, now: Date = new Date()): Promise<ReleaseResult> {
  const icp = await getIcp()
  const outcome = releaseOf(units, icp)
  const patch: Record<string, unknown> = {
    door_count: units,
    door_count_source: 'owner',
    door_count_confidence: 'high',
    attempts: 0,
    last_error: null,
    updated_at: now.toISOString(),
    ...(outcome === 'continue' ? { stage: 'contacts' } : { stage: 'skipped', skip_reason: SKIP_UNDER_MIN_UNITS }),
  }
  const res = await createServiceClient().from('signal_people').update(patch).eq('id', personId).eq('stage', 'held').is('alert_status', null).select('id')
  if (res.error) throw new DbError('signals.releaseHeld', res.error)
  if (!res.data?.length) return { ok: false, error: 'not_held' }
  return { ok: true, outcome, min_units: icp.min_units }
}

/**
 * The owner's typed unit count on a hiring row (the Doors column's control on
 * an account with no count). Stored with source 'owner', confidence 'high'.
 * Only a row that has no count yet changes; it changes no gate, draft or flag.
 */
export async function typeHiringUnits(hiringId: number, units: number, now: Date = new Date()): Promise<{ ok: true } | { ok: false; error: 'not_found' }> {
  const res = await createServiceClient()
    .from('signal_hiring')
    .update({ door_count: units, door_count_source: 'owner', door_count_confidence: 'high', updated_at: now.toISOString() })
    .eq('id', hiringId)
    .is('door_count', null)
    .select('id')
  if (res.error) throw new DbError('signals.typeHiringUnits', res.error)
  return res.data?.length ? { ok: true } : { ok: false, error: 'not_found' }
}
