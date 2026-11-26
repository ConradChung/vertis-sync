import 'server-only'
import { ensureDeal, getDeal, setStage } from '@/lib/crm/service'
import { DbError } from '@/lib/db/service'
import {
  HIRING_COLS, PERSON_COLS, POST_COLS, REACTOR_COLS, REDDIT_COLS,
  hiringEvent, personEvent, reactorEvent, redditEvent,
  type HiringSource, type PersonSource, type PostSource, type ReactorSource, type RedditSource,
} from '@/lib/signals/events'
import {
  applyState, countByStatus, filterRows, mergeSignals, placeholderEmail, SIGNALS_CAMPAIGN_ID,
  type SignalEvent, type SignalFilter, type SignalInbox, type SignalRow, type SignalSource, type SignalState, type SignalStatus, type TouchChannel,
} from '@/lib/signals/merge'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * The Signals inbox's reads and its own state (`signal_accounts`). Service
 * role; call after the route's guard. The four source tables are only ever
 * SELECTed here: nothing in this file writes to them.
 */

const sb = () => createServiceClient()
/** Newest rows read per source. The inbox is a working list, not an archive. */
export const SOURCE_LIMIT = 1000

/** Every signal from the four sources. A source that fails to load is named and the others still come back. */
export async function loadEvents(): Promise<{ events: SignalEvent[]; failed: SignalSource[] }> {
  const failed: SignalSource[] = []
  const safe = async <T>(source: SignalSource, run: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await run()
    } catch (err) {
      console.error(`[signals] ${source} failed:`, err instanceof Error ? err.message : err)
      failed.push(source)
      return []
    }
  }
  const rows = async <T>(op: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> => {
    const res = await q
    if (res.error) throw new DbError(op, res.error as never)
    return (res.data ?? []) as T[]
  }
  const [hiring, people, reddit, reactors] = await Promise.all([
    safe('hiring', () => rows<HiringSource>('signals.hiring', sb().from('signal_hiring').select(HIRING_COLS).eq('stage', 'done').is('skip_reason', null).order('created_at', { ascending: false }).limit(SOURCE_LIMIT))),
    safe('comment', async () => {
      const ppl = await rows<PersonSource>('signals.people', sb().from('signal_people').select(PERSON_COLS).is('skip_reason', null).order('created_at', { ascending: false }).limit(SOURCE_LIMIT))
      const ids = [...new Set(ppl.map((p) => p.post_id).filter((x): x is string => !!x))]
      const posts = ids.length ? await rows<PostSource>('signals.posts', sb().from('signal_posts').select(POST_COLS).in('post_id', ids.slice(0, 500))) : []
      const byId = new Map(posts.map((p) => [p.post_id, p]))
      return ppl.map((p) => ({ p, byId }))
    }),
    safe('reddit', () => rows<RedditSource>('signals.reddit', sb().from('signal_reddit_mentions').select(REDDIT_COLS).order('created_at', { ascending: false }).limit(SOURCE_LIMIT))),
    safe('influencer', () => rows<ReactorSource>('signals.reactors', sb().from('influencer_reactors').select(REACTOR_COLS).eq('verdict', 'verified').order('verified_at', { ascending: false, nullsFirst: false }).limit(SOURCE_LIMIT))),
  ])
  const events = [
    ...hiring.map(hiringEvent),
    ...people.map(({ p, byId }) => personEvent(p, byId)),
    ...reddit.map(redditEvent),
    ...reactors.map(reactorEvent),
  ].filter((e): e is SignalEvent => e !== null)
  return { events, failed }
}

const STATE_COLS = 'account_key, status, email_touched_at, linkedin_touched_at, call_touched_at, deal_id'

export async function loadStates(): Promise<SignalState[]> {
  const res = await sb().from('signal_accounts').select(STATE_COLS).limit(5000)
  if (res.error) throw new DbError('signals.loadStates', res.error)
  return (res.data ?? []) as SignalState[]
}

/** Every account with its state, newest signal first. */
export async function loadAllRows(): Promise<{ rows: SignalRow[]; failed: SignalSource[] }> {
  const [{ events, failed }, states] = await Promise.all([loadEvents(), loadStates()])
  return { rows: applyState(mergeSignals(events), states), failed }
}

/** The inbox shows the newest `limit` matching accounts; `total` says how many match. */
export async function loadInbox(filter: SignalFilter = {}, limit = 100): Promise<SignalInbox> {
  const { rows, failed } = await loadAllRows()
  const shown = filterRows(rows, filter)
  return { rows: shown.slice(0, limit), counts: countByStatus(rows), total: shown.length, failed }
}

export interface AccountPatch {
  status?: SignalStatus
  touch?: { channel: TouchChannel; done: boolean }
}

const TOUCH_COL: Record<TouchChannel, 'email_touched_at' | 'linkedin_touched_at' | 'call_touched_at'> = {
  email: 'email_touched_at',
  linkedin: 'linkedin_touched_at',
  call: 'call_touched_at',
}

async function getState(key: string): Promise<SignalState | null> {
  const res = await sb().from('signal_accounts').select(STATE_COLS).eq('account_key', key).maybeSingle()
  if (res.error) throw new DbError('signals.getState', res.error)
  return (res.data as SignalState | null) ?? null
}

/**
 * Save a status or a touch on an account's own row (created on first use).
 * A tick keeps its first time; unticking clears it. The first touch moves a
 * `new` account to `working`. Returns the saved state, or null when the key
 * is not an account in the inbox (the client never invents one).
 */
export async function patchAccount(key: string, patch: AccountPatch, now: Date = new Date()): Promise<SignalState | null> {
  const { rows } = await loadAllRows()
  const row = rows.find((r) => r.state_key === key || r.key === key)
  if (!row) return null
  const stateKey = row.state_key
  const cur = await getState(stateKey)
  const next: Record<string, unknown> = {
    account_key: stateKey,
    company_name: row.name.slice(0, 300),
    domain: row.domain,
    status: patch.status ?? cur?.status ?? 'new',
    email_touched_at: cur?.email_touched_at ?? null,
    linkedin_touched_at: cur?.linkedin_touched_at ?? null,
    call_touched_at: cur?.call_touched_at ?? null,
    deal_id: cur?.deal_id ?? null,
    updated_at: now.toISOString(),
  }
  if (patch.touch) {
    const col = TOUCH_COL[patch.touch.channel]
    next[col] = patch.touch.done ? (cur?.[col] ?? now.toISOString()) : null
    if (patch.touch.done && !patch.status && next.status === 'new') next.status = 'working'
  }
  const res = await sb().from('signal_accounts').upsert(next, { onConflict: 'account_key' }).select(STATE_COLS).single()
  if (res.error) throw new DbError('signals.patchAccount', res.error)
  return res.data as SignalState
}

export type StartDealResult = { ok: true; deal_id: string; campaign_id: string; created: boolean } | { ok: false; error: 'not_found' }

/**
 * "Start deal": a CRM deal for this account in the Conversation stage, under
 * the `signals` campaign, linked back from the account. Nothing is sent and
 * no pipeline is touched; it is a row on the owner's own board. Pressing it
 * again returns the same deal. With no known email the deal carries a
 * non-routable `@signal.invalid` address (the deal key needs one).
 */
export async function startDeal(key: string, now: Date = new Date()): Promise<StartDealResult> {
  const { rows } = await loadAllRows()
  const row = rows.find((r) => r.state_key === key || r.key === key)
  if (!row) return { ok: false, error: 'not_found' }
  if (row.deal_id) {
    const existing = await getDeal(row.deal_id)
    if (existing) return { ok: true, deal_id: existing.id, campaign_id: existing.campaign_id, created: false }
  }
  const deal = await ensureDeal({
    campaign_id: SIGNALS_CAMPAIGN_ID,
    email: placeholderEmail(row.key),
    source: 'user',
    name: row.contacts[0]?.name ?? null,
    company: row.name.slice(0, 300),
  })
  // A fresh deal starts at Contacted; move it so the stage change is logged (the scoreboard counts it). One the owner already moved stays where it is.
  const created = deal.stage === 'Contacted'
  if (created) await setStage(deal.id, 'Conversation', 'user', null, { via: 'signals', account_key: row.key })
  const cur = await getState(row.state_key)
  const res = await sb()
    .from('signal_accounts')
    .upsert(
      {
        account_key: row.state_key,
        company_name: row.name.slice(0, 300),
        domain: row.domain,
        status: !cur || cur.status === 'new' ? 'working' : cur.status,
        email_touched_at: cur?.email_touched_at ?? null,
        linkedin_touched_at: cur?.linkedin_touched_at ?? null,
        call_touched_at: cur?.call_touched_at ?? null,
        deal_id: deal.id,
        updated_at: now.toISOString(),
      },
      { onConflict: 'account_key' }
    )
  if (res.error) throw new DbError('signals.startDeal', res.error)
  return { ok: true, deal_id: deal.id, campaign_id: deal.campaign_id, created }
}
