import { z } from 'zod'
import type { Json } from '@/lib/db/types'

/**
 * `crm_close_deal` — moving a deal to Won or Lost is confirmed through the
 * Approve/Deny gate (Telegram + /actions/<id>). Payload (pure, client-safe):
 *   { deal_id, stage: 'Won'|'Lost', reason, campaign_id?, lead_email?, lead_name?, summary }
 * The executor (lib/actions/execute.ts) applies it with `crm_set_stage()`.
 * One awaiting action per deal (`pending_actions_one_awaiting_deal_idx`).
 */

export const CRM_CLOSE_KIND = 'crm_close_deal' as const

export const CrmClosePayload = z.object({
  deal_id: z.uuid(),
  stage: z.enum(['Won', 'Lost']),
  reason: z.string().trim().min(1).max(300),
  campaign_id: z.string().trim().max(200).optional(),
  lead_email: z.string().trim().max(320).optional(),
  lead_name: z.string().trim().max(300).optional(),
})

export function crmCloseSummary(p: { stage: string; reason: string; lead_email?: string; lead_name?: string }): string {
  const who = p.lead_name ? `${p.lead_name}${p.lead_email ? ` <${p.lead_email}>` : ''}` : (p.lead_email ?? 'deal')
  return `Mark ${who} as ${p.stage}: “${p.reason.replace(/\s+/g, ' ').slice(0, 120)}”`
}

export function parseCrmClosePayload(payload: unknown): { ok: true; payload: Record<string, Json> } | { ok: false; error: string } {
  const parsed = CrmClosePayload.safeParse(payload)
  if (!parsed.success) return { ok: false, error: 'invalid crm_close_deal payload' }
  const out: Record<string, Json> = {}
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined && v !== '') out[k] = v
  out.deal_id = parsed.data.deal_id.toLowerCase()
  out.summary = crmCloseSummary(parsed.data)
  return { ok: true, payload: out }
}
