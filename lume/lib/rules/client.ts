/**
 * Browser-side calls for the Rotate screen, plus the pure helpers the
 * components share (unit-tested). Calls never throw: a network failure is
 * `{ status: 0 }`. None of these runs anything — assignments and activations
 * only create a pending action that waits for a tap here or in Telegram.
 */
import { sendJson, type ApiAnswer } from '@/lib/validate/client'
import type { LeadBankFilter } from '@/lib/db/leadBankQuery'
import type { Json, LeadBankOrigin } from '@/lib/db/types'
import type { RuleFilter } from '@/lib/rules/filter'

export interface LeadRef {
  origin: LeadBankOrigin
  id: string
}

/** What is being dragged onto a campaign card. */
export type DragLeads =
  | { type: 'leads'; refs: LeadRef[] }
  | { type: 'filter'; filter: RuleFilter; total: number }

export interface ActionAnswer {
  ok: true
  action: { id: string; kind: string; summary: string }
}

export const MAX_DRAG_LEADS = 500

/** Lead-bank screen filter → a rule/assignment filter (`origin` is the view's name for `source`). */
export function toRuleFilter(f: LeadBankFilter): RuleFilter {
  const out: RuleFilter = {}
  const origin = (f.origin ?? f.source)?.trim()
  if (origin === 'lead_bank' || origin === 'validation_rows') out.source = origin
  if (f.icp_status?.trim()) out.icp_status = f.icp_status.trim()
  if (f.city?.trim()) out.city = f.city.trim()
  if (f.since?.trim()) out.since = f.since.trim()
  return out
}

export const refKey = (r: LeadRef) => `${r.origin}:${r.id}`

/** Drag label: "3 leads" / "all 1,204 matching". */
export function dragLabel(d: DragLeads): string {
  if (d.type === 'leads') return `${d.refs.length.toLocaleString('en-US')} lead${d.refs.length === 1 ? '' : 's'}`
  return `all ${d.total.toLocaleString('en-US')} matching`
}

export function requestAssign(campaignId: string, d: DragLeads): Promise<ApiAnswer<ActionAnswer>> {
  const payload =
    d.type === 'leads'
      ? { campaign_id: campaignId, leads: d.refs.slice(0, MAX_DRAG_LEADS) }
      : { campaign_id: campaignId, filter: d.filter }
  return sendJson<ActionAnswer>('/api/actions', { kind: 'assign_leads', payload })
}

export function requestActivate(ruleId: string): Promise<ApiAnswer<ActionAnswer>> {
  return sendJson<ActionAnswer>('/api/actions', { kind: 'activate_rule', payload: { rule_id: ruleId } })
}

export interface RuleInput {
  name: string
  campaign_id: string
  filter: RuleFilter
  daily_cap: number
  order_by: 'newest' | 'oldest'
  cron: string
}

export function createRule(input: RuleInput) {
  return sendJson<{ ok: true; rule: { id: string } }>('/api/rules', input)
}

export function updateRule(id: string, patch: Partial<RuleInput> & { active?: false }) {
  return sendJson<{ ok: true }>(`/api/rules/${id}`, patch, { method: 'PATCH' })
}

export function deleteRule(id: string) {
  return sendJson<{ ok: true }>(`/api/rules/${id}`, undefined, { method: 'DELETE' })
}

export function syncCampaigns() {
  return sendJson<{ configured: boolean; ok?: true; inserted?: number; updated?: number; total?: number }>(
    '/api/campaigns/sync',
    {},
    { timeoutMs: 60_000 }
  )
}

const ERRORS: Record<string, string> = {
  duplicate: 'Already waiting for your confirmation.',
  nothing_to_assign: 'Nothing left to assign — those leads are gone or already queued there.',
  campaign_not_found: 'Campaign not in Lume yet — sync campaigns first.',
  rule_not_found: 'That rule no longer exists.',
  already_active: 'That rule is already active.',
  invalid_cron: 'The schedule is not valid (five fields, at most every 15 minutes).',
  activate_via_action: 'Rules are activated through a confirmation, not directly.',
  activation_awaiting: 'An activation is waiting for confirmation — confirm or reject it first.',
  deactivate_first: 'Pause the rule before deleting it.',
  action_awaiting: 'A confirmation for this rule is still open.',
  invalid_body: 'Check the fields and try again.',
  too_large: 'Too many leads in one drop (max 500).',
}

export function errorText(a: ApiAnswer<unknown>): string {
  if (a.status === 0) return a.aborted ? 'Timed out — refresh to check.' : 'Network error — nothing was sent.'
  const code = (a.body as { error?: string } | null)?.error
  return (code && ERRORS[code]) || `Request failed (${a.status}).`
}

/** `rotation_rules.last_result` → one line for the table. */
export function lastResultLabel(r: Record<string, Json> | null | undefined): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (!r) return { text: 'Never run', tone: 'muted' }
  if (typeof r.error === 'string') return { text: `Error: ${r.error}`, tone: 'warn' }
  if (r.skipped === 'no_candidates') return { text: 'No candidates', tone: 'muted' }
  if (r.skipped === 'action_awaiting') return { text: 'Skipped — confirmation still open', tone: 'muted' }
  if (typeof r.count === 'number' && r.removal === true) return { text: `${r.count.toLocaleString('en-US')} leads to remove, awaiting confirmation`, tone: 'ok' }
  if (typeof r.count === 'number') return { text: `${r.count.toLocaleString('en-US')} leads awaiting confirmation`, tone: 'ok' }
  return { text: '—', tone: 'muted' }
}
