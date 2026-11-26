import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import { countScoreboard, type PilotStart, type Scoreboard, type StageChange } from '@/lib/scoreboard/count'
import { weekOf, type Week } from '@/lib/scoreboard/week'

/**
 * The weekly scoreboard's reads and its one write (the typed "top objection"
 * line, `lume_week_notes`). Service role; call after the route's guard.
 * `campaignIds` narrows the counts to those campaigns (the client portal);
 * omitted, every deal counts.
 */

const ROW_LIMIT = 1000
/** The stage entries the scoreboard counts (`countScoreboard`). */
export const COUNTED_STAGES = ['Conversation', 'Paid'] as const

async function stageChanges(week: Week, campaignIds?: readonly string[]): Promise<StageChange[]> {
  const sb = createServiceClient()
  const cols = campaignIds ? 'deal_id, payload, occurred_at, crm_deals!inner(campaign_id)' : 'deal_id, payload, occurred_at'
  // Only the two targets the scoreboard counts: automation logs a stage change for every reply and
  // bounce, and those rows must not crowd these out of the row cap.
  let q = sb
    .from('crm_activities')
    .select(cols)
    .eq('kind', 'stage_changed')
    .in('payload->>to', [...COUNTED_STAGES])
    .gte('occurred_at', week.start_iso)
    .lt('occurred_at', week.end_iso)
  if (campaignIds) q = q.in('crm_deals.campaign_id', [...campaignIds])
  const res = await q.order('occurred_at', { ascending: false }).limit(ROW_LIMIT)
  if (res.error) throw new DbError('scoreboard.stageChanges', res.error)
  return ((res.data ?? []) as unknown as { deal_id: string; payload: { to?: unknown } | null; occurred_at: string }[]).map((r) => ({
    deal_id: r.deal_id,
    to: typeof r.payload?.to === 'string' ? r.payload.to : null,
    occurred_at: r.occurred_at,
  }))
}

async function pilotStarts(week: Week, campaignIds?: readonly string[]): Promise<PilotStart[]> {
  const sb = createServiceClient()
  let q = sb.from('crm_deals').select('id, pilot_start_date').gte('pilot_start_date', week.start).lt('pilot_start_date', week.end)
  if (campaignIds) q = q.in('campaign_id', [...campaignIds])
  const res = await q.limit(ROW_LIMIT)
  if (res.error) throw new DbError('scoreboard.pilotStarts', res.error)
  return (res.data ?? []) as PilotStart[]
}

export async function getTopObjection(weekStart: string): Promise<string | null> {
  const res = await createServiceClient().from('lume_week_notes').select('top_objection').eq('week_start', weekStart).maybeSingle()
  if (res.error) throw new DbError('scoreboard.getTopObjection', res.error)
  return (res.data as { top_objection: string | null } | null)?.top_objection ?? null
}

/** Save (or clear) this week's line. `weekStart` must be a Monday (the table checks). */
export async function setTopObjection(weekStart: string, text: string | null): Promise<string | null> {
  const value = text?.trim() ? text.trim().slice(0, 300) : null
  const res = await createServiceClient()
    .from('lume_week_notes')
    .upsert({ week_start: weekStart, top_objection: value, updated_at: new Date().toISOString() }, { onConflict: 'week_start' })
  if (res.error) throw new DbError('scoreboard.setTopObjection', res.error)
  return value
}

export async function getScoreboard(now: Date = new Date(), campaignIds?: readonly string[]): Promise<Scoreboard> {
  const week = weekOf(now)
  if (campaignIds && campaignIds.length === 0) {
    return { week: { start: week.start, end: week.end, label: week.label }, counts: { conversations: 0, pilots_started: 0, pilots_paid: 0 }, top_objection: await getTopObjection(week.start) }
  }
  const [changes, starts, top] = await Promise.all([stageChanges(week, campaignIds), pilotStarts(week, campaignIds), getTopObjection(week.start)])
  return { week: { start: week.start, end: week.end, label: week.label }, counts: countScoreboard(changes, starts, week), top_objection: top }
}
