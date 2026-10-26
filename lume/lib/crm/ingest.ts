import 'server-only'
import { logEvent } from '@/lib/db/service'
import type { EventInsert, Json } from '@/lib/db/types'
import { autoAdvance, type CrmSignal } from '@/lib/crm/stages'
import { addActivity, ensureDeal, findLeadByEmail, setStage } from '@/lib/crm/service'
import type { ActivityKind } from '@/lib/crm/types'

/**
 * One ingestion path for every outside signal about a lead — the Instantly
 * webhook today; Gmail recruiter sends and the Muse queue through the
 * adapters below once they are wired (they are NOT hooked up yet: nothing
 * calls `ingestGmailSend` / `ingestMuseEvent`).
 *
 *  1. find or create the deal for (campaign, email) at Contacted, filling
 *     name / company / city from lead_bank when the lead is there;
 *  2. append a crm_activities row, deduped on `dedupe_key` (the events
 *     webhook_id), so a replayed delivery adds nothing;
 *  3. auto-advance the stage with `autoAdvance()` — forward only, or to
 *     Bounced, never to Won/Lost (those go through the approval gate). It is
 *     low-risk, so it applies without a prompt, but every move is logged to
 *     the Agent activity feed as a `lume.crm_stage_auto` event and on the
 *     deal timeline as a stage_changed activity (source agent).
 *
 * Step 3 runs even when step 2 was a duplicate: the move is idempotent, and a
 * retry after a half-finished delivery still lands the stage.
 */

export type IngestSource = 'instantly' | 'gmail' | 'muse'

export interface CrmSignalInput {
  source: IngestSource
  campaign_id: string
  email: string
  signal: CrmSignal
  payload?: Record<string, Json>
  occurred_at?: string
  dedupe_key?: string | null
}

export interface IngestResult {
  deal_id: string
  activity: boolean
  advanced: { from: string; to: string } | null
}

const ACTIVITY_FOR: Record<CrmSignal, ActivityKind | null> = {
  sent: 'sent',
  opened: 'opened',
  replied: 'replied',
  bounced: 'bounced',
  meeting: 'meeting',
  interested: null, // shows up as the stage change (or a note when already past Interested)
}

export async function ingestCrmSignal(input: CrmSignalInput): Promise<IngestResult> {
  const email = input.email.trim().toLowerCase()
  const lead = input.source === 'instantly' ? await findLeadByEmail(input.campaign_id, email) : null
  const deal = await ensureDeal({
    campaign_id: input.campaign_id,
    email,
    source: input.source,
    lead_id: lead?.id ?? null,
    name: lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null : null,
    company: lead?.company_name ?? null,
    city: lead?.location ?? null,
  })

  const kind = ACTIVITY_FOR[input.signal]
  const next = autoAdvance(deal.stage, input.signal)
  let activity = false
  if (kind || !next) {
    const row = await addActivity({
      deal_id: deal.id,
      kind: kind ?? 'note',
      source: input.source,
      payload: kind ? (input.payload ?? {}) : { text: `Marked ${input.signal} in ${input.source}`, signal: input.signal },
      occurred_at: input.occurred_at,
      dedupe_key: input.dedupe_key ?? null,
    })
    activity = row !== null
  }

  if (!next) return { deal_id: deal.id, activity, advanced: null }
  const from = await setStage(deal.id, next, 'agent', null, {
    auto: true,
    signal: input.signal,
    source: input.source,
    ...(input.dedupe_key ? { dedupe_key: input.dedupe_key } : {}),
  })
  if (from === null || from === next) return { deal_id: deal.id, activity, advanced: null }

  const who = deal.name || email
  const ev: EventInsert = {
    type: 'lume.crm_stage_auto',
    source: 'lume',
    source_id: deal.id,
    campaign_id: input.campaign_id,
    lead_email: email,
    title: `CRM: ${who} → ${next} (auto, ${input.signal})`,
    payload: { deal_id: deal.id, from, to: next, signal: input.signal, source: input.source },
  }
  try {
    await logEvent(ev)
  } catch (err) {
    console.error('[crm/ingest] agent activity event failed:', err instanceof Error ? err.message : err)
  }
  return { deal_id: deal.id, activity, advanced: { from, to: next } }
}

/** `events.type` from the Instantly webhook → CRM signal. */
const INSTANTLY_SIGNAL: Record<string, CrmSignal> = {
  sent: 'sent',
  reply: 'replied',
  interested: 'interested',
  bounce: 'bounced',
  'instantly.email_opened': 'opened',
  'instantly.lead_meeting_booked': 'meeting',
}

/**
 * The Instantly webhook's mapped event → CRM. Skips events without a campaign
 * or lead email, and event types the CRM does not track. `webhook_id` is the
 * activity dedupe key.
 */
export async function ingestInstantlyEvent(ev: EventInsert): Promise<IngestResult | null> {
  const signal = INSTANTLY_SIGNAL[ev.type]
  if (!signal || !ev.campaign_id || !ev.lead_email) return null
  const p = (ev.payload ?? {}) as Record<string, Json>
  const ts = typeof p.timestamp === 'string' && Number.isFinite(Date.parse(p.timestamp)) ? new Date(p.timestamp).toISOString() : undefined
  return ingestCrmSignal({
    source: 'instantly',
    campaign_id: ev.campaign_id,
    email: ev.lead_email,
    signal,
    payload: crmPayload(p),
    occurred_at: ts,
    dedupe_key: ev.webhook_id ?? null,
  })
}

/** The fields a timeline/thread needs, not the whole webhook body. */
function crmPayload(p: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {}
  for (const k of ['event_type', 'email_id', 'message_id', 'subject', 'reply_subject', 'reply_text', 'reply_text_snippet', 'text', 'step', 'email_account', 'timestamp']) {
    if (p[k] !== undefined && p[k] !== null) out[k] = p[k]
  }
  if (typeof out.reply_subject === 'string' && out.subject === undefined) out.subject = out.reply_subject
  return out
}

// ---------------------------------------------------------------------------
// Adapters for sources Lume does not ingest yet. NOT WIRED: no route, cron or
// edge function calls these. When Gmail recruiter sends / the Muse queue are
// connected, call them with a stable `id` per message so replays dedupe.

/** A Gmail recruiter-campaign message (`direction: 'out'` = our send, `'in'` = their reply). */
export async function ingestGmailSend(m: {
  id: string
  campaign_id: string // lume_campaigns.external_id, e.g. 'gmail:recruiter'
  email: string
  direction: 'out' | 'in'
  subject?: string
  text?: string
  sent_at?: string
}): Promise<IngestResult> {
  return ingestCrmSignal({
    source: 'gmail',
    campaign_id: m.campaign_id,
    email: m.email,
    signal: m.direction === 'in' ? 'replied' : 'sent',
    payload: { ...(m.subject ? { subject: m.subject } : {}), ...(m.text ? { text: m.text.slice(0, 4000) } : {}) },
    occurred_at: m.sent_at,
    dedupe_key: `gmail:${m.id}`,
  })
}

/** A Muse auto-apply queue event. Only `replied` moves a stage. */
export async function ingestMuseEvent(e: {
  id: string
  campaign_id: string // e.g. 'muse:auto-apply'
  email: string
  kind: 'queued' | 'sent' | 'replied'
  text?: string
  at?: string
}): Promise<IngestResult | null> {
  if (e.kind === 'queued') return null
  return ingestCrmSignal({
    source: 'muse',
    campaign_id: e.campaign_id,
    email: e.email,
    signal: e.kind === 'replied' ? 'replied' : 'sent',
    payload: e.text ? { text: e.text.slice(0, 4000) } : {},
    occurred_at: e.at,
    dedupe_key: `muse:${e.id}`,
  })
}
