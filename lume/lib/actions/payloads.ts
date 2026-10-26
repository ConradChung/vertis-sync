import { z } from 'zod'
import type { Json } from '@/lib/db/types'

/**
 * Campaign-scoped pending-action kinds and their payload schemas — the ONE
 * validator per kind, used by `POST /api/actions` (client / agent input) and
 * by `createAction` (every caller), so what `lib/actions/execute.ts` reads is
 * always what was validated here. Pure and client-safe.
 *
 * Shapes (executor fields first; the rest are display extras):
 *   send_reply      { eaccount, reply_to_uuid, body, subject?,
 *                     campaign_id?, lead_email?, campaign_name?,
 *                     recipient_verified? }
 *   pause_campaign  { campaign_id, campaign_name? }
 *   resume_campaign { campaign_id, campaign_name? }
 *   create_campaign { source_campaign_id, name, campaign_name? }
 * plus a `summary` (written here when absent). Unknown keys are dropped.
 * `buildActionRequest` (lib/actions/build.ts) overwrites the display extras
 * server-side before this runs: `campaign_name` from `lume_campaigns` (or
 * Instantly), `lead_email` + `recipient_verified` from the email lookup.
 * Aliases accepted for older callers: send_reply `to` → `lead_email`,
 * create_campaign `source_name` → `campaign_name`.
 *
 * Dedupe: one awaiting action per kind and `CAMPAIGN_ACTION_KEY` value,
 * checked in `createAction`; pause/resume (campaign_id) and send_reply
 * (reply_to_uuid) are also DB-enforced by partial unique indexes
 * (migration `lume_pending_actions_campaign_unique`, 23505 → duplicate).
 */

export const CAMPAIGN_ACTION_KINDS = ['send_reply', 'pause_campaign', 'resume_campaign', 'create_campaign'] as const
export type CampaignActionKind = (typeof CAMPAIGN_ACTION_KINDS)[number]

const ID = z.string().trim().min(1).max(200)
const LABEL = z.string().trim().max(300).optional()

export const CAMPAIGN_PAYLOADS = {
  send_reply: z.object({
    eaccount: z.email().max(320),
    reply_to_uuid: ID,
    body: z.string().trim().min(1).max(20_000),
    subject: LABEL,
    campaign_id: ID.optional(),
    lead_email: LABEL,
    campaign_name: LABEL,
    /** Set by the server builder: false when the recipient could not be looked up. */
    recipient_verified: z.boolean().optional(),
  }),
  pause_campaign: z.object({ campaign_id: ID, campaign_name: LABEL }),
  resume_campaign: z.object({ campaign_id: ID, campaign_name: LABEL }),
  create_campaign: z.object({
    source_campaign_id: ID,
    name: z.string().trim().min(1).max(200),
    campaign_name: LABEL,
  }),
} as const satisfies Record<CampaignActionKind, z.ZodType>

export type CampaignActionPayload<K extends CampaignActionKind> = z.infer<(typeof CAMPAIGN_PAYLOADS)[K]>

/** The payload field that identifies "the same action" for dedupe. */
export const CAMPAIGN_ACTION_KEY: Record<CampaignActionKind, string> = {
  send_reply: 'reply_to_uuid',
  pause_campaign: 'campaign_id',
  resume_campaign: 'campaign_id',
  create_campaign: 'source_campaign_id',
}

export function isCampaignActionKind(kind: string): kind is CampaignActionKind {
  return (CAMPAIGN_ACTION_KINDS as readonly string[]).includes(kind)
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function campaignActionSummary(kind: CampaignActionKind, p: Record<string, unknown>): string {
  const camp = String(p.campaign_name || p.campaign_id || p.source_campaign_id || '')
  switch (kind) {
    case 'send_reply': {
      const unverified = p.recipient_verified === false
      const to = p.lead_email
        ? ` to ${p.lead_email}${unverified ? ' (unverified)' : ''}`
        : unverified
          ? ' to an unverified recipient'
          : ''
      const where = camp ? ` (${camp})` : ''
      return `Send reply${to} from ${p.eaccount}${where}: “${clip(String(p.body ?? '').replace(/\s+/g, ' '), 80)}”`
    }
    case 'pause_campaign':
      return `Pause campaign ${camp}`
    case 'resume_campaign':
      return `Resume campaign ${camp}`
    case 'create_campaign':
      return `Duplicate ${camp} as “${p.name}”`
  }
}

function withAliases(kind: CampaignActionKind, payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const p = { ...(payload as Record<string, unknown>) }
  if (kind === 'send_reply' && p.lead_email === undefined && typeof p.to === 'string') p.lead_email = p.to
  if (kind === 'create_campaign' && p.campaign_name === undefined && typeof p.source_name === 'string') {
    p.campaign_name = p.source_name
  }
  return p
}

/**
 * Validate a campaign-kind payload. Returns the cleaned payload (unknown and
 * undefined fields dropped, `summary` filled) or an error message.
 * `trustSummary: false` (the API route) ignores a caller-supplied summary so
 * the confirmation text is always server-written.
 */
export function parseCampaignPayload(
  kind: CampaignActionKind,
  payload: unknown,
  opts: { trustSummary?: boolean } = {}
): { ok: true; payload: Record<string, Json> } | { ok: false; error: string } {
  const parsed = CAMPAIGN_PAYLOADS[kind].safeParse(withAliases(kind, payload))
  if (!parsed.success) return { ok: false, error: `invalid ${kind} payload` }
  const out: Record<string, Json> = {}
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined && v !== '') out[k] = v as Json
  const given = opts.trustSummary === false ? undefined : (payload as { summary?: unknown } | null)?.summary
  out.summary = typeof given === 'string' && given.trim() ? given.trim() : campaignActionSummary(kind, out)
  return { ok: true, payload: out }
}
