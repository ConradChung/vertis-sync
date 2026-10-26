import { z } from 'zod'
import type { Json } from '@/lib/db/types'

/**
 * Campaign-scoped pending-action kinds (Task 13) and their payload schemas.
 * Shared by `createAction` (validation + dedupe) and `POST /api/actions`.
 * Pure and client-safe.
 *
 * These kinds carry no `job_id`; one awaiting action per kind and
 * `CAMPAIGN_ACTION_KEY` value is enforced in `createAction` (no unique index
 * backs it — `pending_actions_one_awaiting_idx` only covers rows with a job).
 */

export const CAMPAIGN_ACTION_KINDS = ['send_reply', 'pause_campaign', 'resume_campaign', 'create_campaign'] as const
export type CampaignActionKind = (typeof CAMPAIGN_ACTION_KINDS)[number]

const ID = z.string().trim().min(1).max(200)
const LABEL = z.string().trim().max(300).optional()

export const CAMPAIGN_PAYLOADS = {
  send_reply: z.object({
    campaign_id: ID,
    eaccount: z.email().max(320),
    reply_to_uuid: ID,
    body: z.string().trim().min(1).max(20_000),
    subject: LABEL,
    lead_email: LABEL,
    campaign_name: LABEL,
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
      const to = p.lead_email ? ` to ${p.lead_email}` : ''
      return `Send reply${to} from ${p.eaccount} (${camp}): “${clip(String(p.body ?? '').replace(/\s+/g, ' '), 80)}”`
    }
    case 'pause_campaign':
      return `Pause campaign ${camp}`
    case 'resume_campaign':
      return `Resume campaign ${camp}`
    case 'create_campaign':
      return `Duplicate ${camp} as “${p.name}”`
  }
}

/**
 * Validate a campaign-kind payload. Returns the cleaned payload (undefined
 * fields dropped, `summary` filled) or an error message.
 */
export function parseCampaignPayload(
  kind: CampaignActionKind,
  payload: unknown
): { ok: true; payload: Record<string, Json> } | { ok: false; error: string } {
  const parsed = CAMPAIGN_PAYLOADS[kind].safeParse(payload)
  if (!parsed.success) return { ok: false, error: `invalid ${kind} payload` }
  const out: Record<string, Json> = {}
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) out[k] = v as Json
  const given = (payload as { summary?: unknown } | null)?.summary
  out.summary = typeof given === 'string' && given.trim() ? given.trim() : campaignActionSummary(kind, out)
  return { ok: true, payload: out }
}
