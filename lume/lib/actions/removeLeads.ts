import 'server-only'
import { z } from 'zod'
import { createAction, DuplicateActionError } from '@/lib/actions/create'
import { InstantlyError, isInstantlyConfigured } from '@/lib/adapters/instantly'
import { getCampaignLeadCount, getLeadsByIds, listCampaignLeads, MAX_SCAN_PAGES, type FetchedLead } from '@/lib/adapters/instantlyLeads'
import { MAX_DAYS, protectedReason, type CampaignLead } from '@/lib/adapters/instantlyLeads.map'
import { deleteLead } from '@/lib/adapters/instantlyWrite'
import { countCandidates, getCampaignByExternalId, getRule } from '@/lib/db/service'
import type { Json, PendingActionRow } from '@/lib/db/types'
import { archiveLeadBankRows, countQueuedForCampaign, deleteCycledLeads, insertCycledLeads } from '@/lib/leads/cycledStore'
import { parseCycleParams, refillCount } from '@/lib/rules/cycle'
import { parseRuleFilter, summarizeFilter } from '@/lib/rules/filter'
import { CAMPAIGN_ID_RE } from '@/lib/rules/schema'
import { LEAD_ID, MAX_REMOVE, removeLeadsPayloadError } from '@/lib/actions/removeLeadsPayload'

export { MAX_REMOVE, removeLeadsPayloadError }

/**
 * remove_leads: delete leads from an Instantly campaign to free the contact
 * cap (only deleting frees it; Instantly releases the slots 5–10 min later).
 *
 * Request (POST /api/actions, the agent, the cycle-out tick):
 *   { campaign_id, reason, lead_ids: [..] }                      or
 *   { campaign_id, reason, filter: { state, older_than_days? } }
 *   state: finished_no_reply | bounced | no_reply_after_days (needs older_than_days)
 *
 * The builder reads the leads from Instantly NOW and freezes the removable
 * ids (≤ 1,000) in the payload, so the owner approves an exact count:
 *   { campaign_id, campaign_name, lead_ids, count, reason, kept_replied,
 *     kept_interested, not_found, filter?, sample, summary }
 *
 * The executor re-reads those leads and ALWAYS skips any that replied or are
 * interested by then (or are gone), snapshots each remaining lead into
 * lume_cycled_leads, deletes them by id, archives their lead_bank rows (like
 * the rotator does) and, for a cycle-out rule with refill_to, files the
 * refill as an assign_leads action. CRM deals and their history are untouched.
 */

export const removeLeadsBody = z
  .strictObject({
    campaign_id: z.string().trim().regex(CAMPAIGN_ID_RE),
    reason: z.string().trim().min(1).max(300),
    lead_ids: z.array(LEAD_ID).min(1).max(MAX_REMOVE).optional(),
    filter: z
      .strictObject({
        state: z.enum(['finished_no_reply', 'bounced', 'no_reply_after_days']),
        older_than_days: z.number().int().min(1).max(MAX_DAYS).optional(),
      })
      .refine((f) => f.state !== 'no_reply_after_days' || f.older_than_days !== undefined, 'no_reply_after_days needs older_than_days')
      .optional(),
  })
  .refine((v) => !!v.lead_ids !== !!v.filter, 'lead_ids or filter, not both')

export type RemoveLeadsRequest = z.infer<typeof removeLeadsBody>

export type RemoveBuild =
  | { ok: true; payload: Record<string, Json> & { summary: string } }
  | { ok: false; status: number; error: string }

const fmt = new Intl.NumberFormat('en-US')
const plural = (n: number, w: string) => `${fmt.format(n)} ${w}${n === 1 ? '' : 's'}`
const STATE_LABEL: Record<string, string> = {
  finished_no_reply: 'sequence finished, no reply',
  bounced: 'bounced',
  no_reply_after_days: 'no reply',
}

export async function buildRemoveLeads(
  p: RemoveLeadsRequest,
  opts: { campaignName: (id: string) => Promise<string>; max?: number; now?: Date }
): Promise<RemoveBuild> {
  if (!isInstantlyConfigured()) return { ok: false, status: 503, error: 'instantly_not_configured' }
  const max = Math.min(opts.max ?? MAX_REMOVE, MAX_REMOVE)
  let candidates: CampaignLead[]
  let notFound = 0
  let more = false
  try {
    if (p.lead_ids) {
      const unique = [...new Set(p.lead_ids)]
      candidates = (await getLeadsByIds(p.campaign_id, unique)).map((f) => f.lead)
      notFound = unique.length - candidates.length
    } else {
      const f = p.filter!
      const r = await listCampaignLeads(
        p.campaign_id,
        { state: f.state, ...(f.older_than_days !== undefined ? { days: f.older_than_days } : {}) },
        { limit: MAX_REMOVE, maxPages: MAX_SCAN_PAGES, now: opts.now }
      )
      candidates = r.leads
      more = r.truncated || r.matched > r.leads.length
    }
  } catch (err) {
    console.error('[remove_leads] Instantly read failed:', err instanceof Error ? err.message : err)
    return { ok: false, status: 502, error: err instanceof InstantlyError && err.status === 0 ? 'instantly_unreachable' : 'instantly_failed' }
  }

  let keptReplied = 0
  let keptInterested = 0
  const removable: CampaignLead[] = []
  for (const l of candidates) {
    const why = protectedReason(l)
    if (why === 'replied') keptReplied++
    else if (why === 'interested') keptInterested++
    else removable.push(l)
  }
  if (removable.length > max) more = true
  const take = removable.slice(0, max)
  if (!take.length) return { ok: false, status: 409, error: 'nothing_to_remove' }

  const name = await opts.campaignName(p.campaign_id)
  const kept = keptReplied + keptInterested
  const what = p.filter
    ? ` (${STATE_LABEL[p.filter.state]}${p.filter.older_than_days ? `, last email ${p.filter.older_than_days}+ days ago` : ''})`
    : ''
  const payload: Record<string, Json> & { summary: string } = {
    campaign_id: p.campaign_id,
    campaign_name: name,
    lead_ids: take.map((l) => l.id),
    count: take.length,
    reason: p.reason,
    kept_replied: keptReplied,
    kept_interested: keptInterested,
    not_found: notFound,
    sample: take.slice(0, 5).map((l) => l.email ?? l.id),
    summary:
      `Remove ${plural(take.length, 'lead')} from ${name}${what}: ${p.reason}. ` +
      (kept ? `${plural(kept, 'replied/interested lead')} kept. ` : '') +
      (more ? 'More match; this takes the first batch. ' : '') +
      'Each lead is snapshotted first; contacts free up in Instantly 5–10 min after.',
  }
  if (p.filter) payload.filter = p.filter as Record<string, Json>
  return { ok: true, payload }
}

export class RemovalFailure extends Error {
  readonly result: Record<string, Json>
  constructor(message: string, result: Record<string, Json>) {
    super(message)
    this.name = 'RemovalFailure'
    this.result = result
  }
}

const CHUNK = 100
const SKIPPED_SHOWN = 50
/** lume_cycled_leads / lead_bank cap emails at 320 chars; a longer one is stored as null (the raw snapshot keeps it). */
const storableEmail = (e: string | null) => (e && e.length <= 320 ? e : null)
/** Per-lead deletes in flight (Instantly: 100 rps / 6,000 per min workspace-wide). */
export const DELETE_CONCURRENCY = 5
/** Time for the delete phase; the execute route's maxDuration is 300 s (reads + refill need the rest). */
export const DELETE_BUDGET_MS = 200_000

interface DeleteOutcome {
  deleted: FetchedLead[]
  gone: FetchedLead[]
  untouched: FetchedLead[]
  /** Attempted and failed: Instantly may or may not have deleted these (their snapshots stay). */
  failed: { lead: FetchedLead; error: unknown }[]
}

/** Delete each lead by id, DELETE_CONCURRENCY at a time; stop starting new ones on a failure or when `outOfTime()`. */
async function deleteEach(leads: FetchedLead[], outOfTime: () => boolean): Promise<DeleteOutcome> {
  const out: DeleteOutcome = { deleted: [], gone: [], untouched: [], failed: [] }
  let next = 0
  const worker = async () => {
    while (!out.failed.length && next < leads.length) {
      const f = leads[next++]
      if (outOfTime()) {
        out.untouched.push(f)
        continue
      }
      try {
        if ((await deleteLead(f.lead.id)) === 'deleted') out.deleted.push(f)
        else out.gone.push(f)
      } catch (error) {
        out.failed.push({ lead: f, error })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, leads.length) }, worker))
  if (out.failed.length) out.untouched.push(...leads.slice(next))
  return out
}
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

/** Execute a confirmed remove_leads row. Throws RemovalFailure (with a partial result) on failure. */
export async function executeRemoveLeads(
  p: Record<string, Json>,
  action: Pick<PendingActionRow, 'id' | 'rule_id'>,
  opts: { now?: Date; budgetMs?: number; clock?: () => number } = {}
): Promise<Record<string, Json>> {
  const now = opts.now ?? new Date()
  const err = removeLeadsPayloadError(p)
  if (err) throw new RemovalFailure(err, {})
  const campaignId = p.campaign_id as string
  const ids = [...new Set(p.lead_ids as string[])]
  const reason = typeof p.reason === 'string' ? p.reason.slice(0, 300) : null

  // 1. Re-read: anything that replied, turned interested or vanished since approval is skipped.
  // A cycle-out (rule) or finished_no_reply removal also needs the sequence still
  // completed: a lead that bounced or went back into sequence since filing stays.
  const filter = p.filter && typeof p.filter === 'object' && !Array.isArray(p.filter) ? (p.filter as Record<string, Json>) : null
  const needsFinished = !!action.rule_id || filter?.state === 'finished_no_reply'
  const fetched = await getLeadsByIds(campaignId, ids)
  const byId = new Map(fetched.map((f) => [f.lead.id, f]))
  const skipped: { id: string; email: string | null; why: string }[] = []
  const removable: typeof fetched = []
  for (const id of ids) {
    const f = byId.get(id)
    if (!f) {
      skipped.push({ id, email: null, why: 'not_found' })
      continue
    }
    const why = protectedReason(f.lead) ?? (needsFinished && f.lead.status !== 3 ? (f.lead.status === -1 ? 'bounced' : 'no_longer_finished') : null)
    if (why) skipped.push({ id, email: f.lead.email, why })
    else removable.push(f)
  }
  const skippedCounts: Record<string, number> = { replied: 0, interested: 0, not_found: 0 }
  for (const s of skipped) skippedCounts[s.why] = (skippedCounts[s.why] ?? 0) + 1

  // Refill needs the campaign's size before the delete (Instantly's count lags it).
  const rule = action.rule_id ? await getRule(action.rule_id).catch(() => null) : null
  const cycle = rule && rule.kind === 'cycle_out' ? parseCycleParams(rule.params) : null
  const leadsBefore = cycle?.refill_to && removable.length ? await getCampaignLeadCount(campaignId).catch(() => null) : null

  let removed = 0
  const deletedLeads: FetchedLead[] = []
  let remainingIds: string[] = []
  const base = (): Record<string, Json> => ({
    campaign_id: campaignId,
    requested: ids.length,
    removed,
    skipped: skippedCounts,
    skipped_leads: skipped.slice(0, SKIPPED_SHOWN),
  })
  const goneAtDelete = (f: FetchedLead) => {
    skipped.push({ id: f.lead.id, email: f.lead.email, why: 'not_found' })
    skippedCounts.not_found = (skippedCounts.not_found ?? 0) + 1
  }
  const dropSnapshots = (leads: FetchedLead[]) =>
    leads.length ? deleteCycledLeads(action.id, leads.map((f) => f.lead.id)).catch((e) => console.error('[remove_leads] snapshot cleanup failed:', msg(e))) : undefined

  // 2. Snapshot a chunk of 100, then delete that chunk's leads ONE BY ONE
  // (DELETE /leads/{id}, 5 in flight), inside a time budget well under the
  // route's 300 s. A 404 is "already gone" (not_found). Leads never attempted
  // (budget out, or after a failure) keep nothing: their snapshots are
  // dropped. A failed delete keeps its own snapshot (it may have gone through)
  // and stops the run as uncertain.
  const clock = opts.clock ?? Date.now
  const deadline = clock() + (opts.budgetMs ?? DELETE_BUDGET_MS)
  for (let i = 0; i < removable.length; i += CHUNK) {
    const chunk = removable.slice(i, i + CHUNK)
    if (clock() >= deadline) {
      remainingIds = removable.slice(i).map((f) => f.lead.id)
      break
    }
    try {
      await insertCycledLeads(
        chunk.map((f) => ({
          campaign_id: campaignId,
          instantly_lead_id: f.lead.id,
          email: storableEmail(f.lead.email),
          snapshot: f.raw as Record<string, Json>,
          reason,
          action_id: action.id,
        }))
      )
    } catch (e) {
      // This chunk is never deleted without its snapshot. Earlier chunks were:
      // the run partly happened, so it is uncertain.
      throw new RemovalFailure(`Lead snapshot failed after ${removed} removed: ${msg(e)}`, {
        ...base(),
        ...(removed ? { uncertain: true } : {}),
        remaining: removable.length - i,
      })
    }
    const out = await deleteEach(chunk, () => clock() >= deadline)
    deletedLeads.push(...out.deleted)
    removed += out.deleted.length
    out.gone.forEach(goneAtDelete)
    await dropSnapshots([...out.gone, ...out.untouched])
    if (out.failed.length) {
      const untouched = [...out.untouched, ...removable.slice(i + CHUNK)]
      const first = out.failed[0]
      throw new RemovalFailure(`Instantly delete of lead ${first.lead.lead.id} failed after ${removed} removed: ${msg(first.error)}`, {
        ...base(),
        uncertain: true,
        failed_lead_ids: out.failed.map((x) => x.lead.lead.id),
        remaining: untouched.length,
        remaining_lead_ids: untouched.map((f) => f.lead.id),
      })
    }
    if (out.untouched.length) {
      remainingIds = [...out.untouched, ...removable.slice(i + CHUNK)].map((f) => f.lead.id)
      break
    }
  }

  const result = base()
  if (remainingIds.length) {
    // Cleanly stopped on the time budget: nothing half-done, the rest untouched.
    result.stopped = 'time_budget'
    result.uncertain = false
    result.remaining = remainingIds.length
    result.remaining_lead_ids = remainingIds
  }

  // 3. lead_bank bookkeeping (never fails the removal).
  if (removed) {
    try {
      result.lead_bank_archived = await archiveLeadBankRows(
        campaignId,
        deletedLeads.flatMap((f) => {
          const email = storableEmail(f.lead.email)
          return email ? [{ email, status: f.lead.status }] : []
        }),
        now.toISOString()
      )
    } catch (e) {
      result.lead_bank_error = msg(e)
    }
  }

  // 4. Cycle-out refill: an assign_leads action, exactly as the rotation tick
  // files one. A refill only ever follows a removal: when this run removed
  // nothing (and the tick files no removal when there is nothing to cycle
  // out) the campaign is not topped up, even if it is under refill_to.
  if (cycle?.refill_to && rule) {
    result.refill = !removed
      ? { skipped: 'nothing_removed' }
      : leadsBefore === null
        ? { skipped: 'lead_count_unavailable' }
        : await fileRefill(rule, cycle.refill_to, leadsBefore - removed)
  }
  return result
}

async function fileRefill(
  rule: { id: string; name: string; campaign_id: string; filter: unknown; order_by: 'newest' | 'oldest'; daily_cap: number },
  refillTo: number,
  inCampaign: number
): Promise<Record<string, Json>> {
  try {
    const filter = parseRuleFilter(rule.filter)
    const [queued, available] = await Promise.all([countQueuedForCampaign(rule.campaign_id), countCandidates(filter, rule.campaign_id)])
    const count = refillCount({ refillTo, inCampaign, queued, available })
    if (!count) return { skipped: available ? 'at_target' : 'no_candidates', in_campaign: inCampaign, queued, available }
    const campaignName = (await getCampaignByExternalId(rule.campaign_id).catch(() => null))?.name ?? rule.campaign_id
    const action = await createAction(
      'assign_leads',
      {
        campaign_id: rule.campaign_id,
        campaign_name: campaignName,
        filter: filter as Record<string, Json>,
        order_by: rule.order_by,
        count,
        available,
        rule_id: rule.id,
        rule_name: rule.name,
        summary:
          `Refill ${plural(count, 'lead')} → ${campaignName} to reach ${fmt.format(refillTo)} ` +
          `(cycle-out rule "${rule.name}": ${summarizeFilter(filter)}, ${rule.order_by} first; ${fmt.format(available)} available). ` +
          'Instantly frees the removed leads\' slots 5–10 minutes after deletion; approve after that so the push has room.',
      },
      'rule',
      { ruleId: rule.id }
    )
    return { action_id: action.id, count, in_campaign: inCampaign, queued, available }
  } catch (e) {
    if (e instanceof DuplicateActionError) return { skipped: 'action_awaiting', ...(e.existingId ? { action_id: e.existingId } : {}) }
    return { error: msg(e) }
  }
}
