import 'server-only'
import type { Json, PendingActionKind } from '@/lib/db/types'
import { isInstantlyConfigured, listAccounts, listCampaigns } from '@/lib/adapters/instantly'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError, CAMPAIGN_CHOICE_STATUSES } from '@/lib/db/service'
import { jobName } from '@/lib/validate/jobs'
import { noLocationName, stripLocationVariants } from '@/lib/validate/noLocation'
import { loadTemplates, loadVerticals } from '@/lib/campaigns/suggestData'
import { rankTemplatesFor } from '@/lib/campaigns/suggest'
import { DEFAULT_SCHEDULE, NEW_CAMPAIGN_KIND, NewCampaignInput, newCampaignPayloadError, newCampaignSummary } from '@/lib/campaigns/newCampaignPayload'

/**
 * Server builder for `new_campaign` (POST /api/campaigns/new, POST /api/actions,
 * the agent's create_campaign tool). Checks the request against live data and
 * freezes what the owner confirms: the inboxes must be Instantly accounts, the
 * tag and template must exist, the name must be free in Instantly; the copy
 * (template sequences) and the No-Location sibling's copy are snapshotted into
 * the payload. Nothing is created here — the executor
 * (lib/campaigns/newCampaignExec.ts) runs after the tap.
 */

type Fail = { ok: false; status: number; error: string; problems?: string[] }
export type NewCampaignBuild = { ok: true; kind: PendingActionKind; payload: Record<string, Json> & { summary: string } } | Fail

const fail = (status: number, error: string, problems?: string[]): Fail => ({ ok: false, status, error, ...(problems?.length ? { problems } : {}) })

export async function buildNewCampaign(raw: Record<string, unknown>): Promise<NewCampaignBuild> {
  const parsed = NewCampaignInput.safeParse(raw)
  if (!parsed.success) return fail(400, 'invalid_payload', parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`))
  const input = parsed.data
  if (!isInstantlyConfigured()) return fail(400, 'instantly_not_configured')

  let accounts: Set<string>
  let names: Set<string>
  try {
    const [acc, camps] = await Promise.all([listAccounts(), listCampaigns()])
    accounts = new Set(acc.map((a) => a.email.toLowerCase()))
    names = new Set(camps.map((c) => c.name.trim().toLowerCase()))
  } catch (err) {
    console.error('[campaigns/new] Instantly read failed:', err instanceof Error ? err.message : err)
    return fail(502, 'instantly_unavailable')
  }
  const emailList = [...new Set(input.email_list.map((e) => e.trim().toLowerCase()))]
  const unknown = emailList.filter((e) => !accounts.has(e))
  if (unknown.length) return fail(400, 'unknown_inboxes', unknown)
  const name = input.name.trim()
  if (names.has(name.toLowerCase())) return fail(409, 'name_taken')

  const [verticals, templates] = await Promise.all([loadVerticals(), loadTemplates()])
  const vertical = input.vertical_id ? verticals.find((v) => v.id === input.vertical_id!.toLowerCase()) : null
  if (input.vertical_id && !vertical) return fail(400, 'unknown_vertical')

  let sequences: unknown = input.sequences
  let template: { id: string; name: string } | null = null
  if (input.template_id) {
    const t = templates.find((x) => x.id === input.template_id!.toLowerCase())
    if (!t) return fail(400, 'unknown_template')
    template = { id: t.id, name: t.name }
    sequences = t.sequences
  }

  let noLocation: { name: string; sequences: Json; template_name?: string } | undefined
  if (input.no_location_sibling) {
    const nlName = noLocationName(name)
    if (names.has(nlName.toLowerCase())) return fail(409, 'name_taken', [nlName])
    const stripped = stripLocationVariants(sequences)
    if (stripped.ok && stripped.removed === 0) return fail(400, 'nolocation_not_needed')
    if (stripped.ok) {
      noLocation = { name: nlName, sequences: stripped.sequences as unknown as Json }
    } else {
      // A step can't send without a city: use the tag's No-Location template instead.
      const alt = rankTemplatesFor(templates, vertical ?? null).find((t) => t.no_location && !t.uses_location)
      const src = alt ? templates.find((t) => t.id === alt.id) : undefined
      if (!src) return fail(409, 'nolocation_needs_template')
      noLocation = { name: nlName, sequences: src.sequences as Json, template_name: src.name }
    }
  }

  let jobLabel: string | undefined
  let jobAwaiting = false
  const jobId = input.job_id?.toLowerCase()
  if (jobId) {
    const res = await createServiceClient()
      .from('validation_jobs')
      .select('id,filename,display_name,total_rows,created_at,instantly_status')
      .eq('id', jobId)
      .maybeSingle()
    if (res.error) throw new DbError('buildNewCampaign.job', res.error)
    const j = res.data as { filename: string | null; display_name: string | null; total_rows: number | null; created_at: string; instantly_status: string | null } | null
    if (!j) return fail(404, 'unknown_job')
    jobLabel = jobName({ total_rows: j.total_rows ?? 0, created_at: j.created_at, display_name: j.display_name ?? j.filename })
    jobAwaiting = (CAMPAIGN_CHOICE_STATUSES as readonly string[]).includes(j.instantly_status ?? '')
  }

  const payload: Record<string, Json> = {
    name,
    name_key: name.toLowerCase(),
    sequences: sequences as Json,
    email_list: emailList,
    campaign_schedule: (input.campaign_schedule ?? DEFAULT_SCHEDULE) as unknown as Json,
    daily_limit: input.daily_limit,
    stop_on_reply: input.stop_on_reply,
    ...(vertical ? { vertical_id: vertical.id, vertical_name: vertical.name } : {}),
    ...(template ? { template_id: template.id, template_name: template.name } : {}),
    ...(noLocation ? { no_location: noLocation as unknown as Json } : {}),
    ...(jobId ? { job_id: jobId, job_label: jobLabel ?? null, job_awaiting_campaign: jobAwaiting } : {}),
    ...(input.list_id ? { list_id: input.list_id.toLowerCase() } : {}),
  }
  const err = newCampaignPayloadError(payload)
  if (err) return fail(422, 'invalid_sequences', [err])
  const summary = newCampaignSummary({ ...payload, job_label: jobAwaiting ? jobLabel : undefined })
  return { ok: true, kind: NEW_CAMPAIGN_KIND, payload: { ...payload, summary } }
}
