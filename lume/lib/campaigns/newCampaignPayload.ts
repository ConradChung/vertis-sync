import { z } from 'zod'
import type { Json } from '@/lib/db/types'

/**
 * `new_campaign`: create an Instantly campaign from scratch (not a duplicate)
 * after the owner's tap. Pure and client-safe.
 *
 *   NewCampaignInput — what the sheet / agent sends (POST /api/campaigns/new,
 *     or POST /api/actions { kind: 'new_campaign' }); the server builder
 *     (lib/campaigns/newCampaign.ts) checks the inboxes, the tag and the
 *     template against live data and freezes the copy into the payload.
 *   newCampaignPayloadError — the executor's fields, re-checked by
 *     createAction on every insert.
 *
 * Executor payload: { name, name_key, sequences, email_list, campaign_schedule,
 *   daily_limit, stop_on_reply, vertical_id?, vertical_name?, template_id?,
 *   template_name?, job_id?, list_id?, no_location?: { name, sequences },
 *   summary }. The campaign is created as a draft; nothing ever launches it here.
 */

export const NEW_CAMPAIGN_KIND = 'new_campaign' as const
/** Dedupe: one awaiting new_campaign per lowercased name (pending_actions_one_awaiting_new_campaign_idx). */
export const NEW_CAMPAIGN_KEY = 'name_key'

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

export const ScheduleSchema = z.looseObject({
  schedules: z
    .array(
      z.looseObject({
        name: z.string().trim().min(1).max(120),
        timing: z.object({ from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) }),
        days: z.record(z.string().regex(/^[0-6]$/), z.boolean()),
        timezone: z.string().trim().min(1).max(80),
      })
    )
    .min(1)
    .max(10),
})

export type CampaignSchedule = z.infer<typeof ScheduleSchema>

/** Used only when there is no campaign to copy a schedule from: weekdays 9–5 Central. */
export const DEFAULT_SCHEDULE: CampaignSchedule = {
  schedules: [
    {
      name: 'Weekdays',
      timing: { from: '09:00', to: '17:00' },
      days: { '1': true, '2': true, '3': true, '4': true, '5': true },
      timezone: 'America/Chicago',
    },
  ],
}

export const DEFAULT_DAILY_LIMIT = 50

const SequencesSchema = z
  .array(z.looseObject({ steps: z.array(z.looseObject({ variants: z.array(z.looseObject({})).min(1) })).min(1) }))
  .min(1)
  .max(5)

export const NewCampaignInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    vertical_id: UUID.nullish(),
    template_id: UUID.nullish(),
    sequences: SequencesSchema.optional(),
    email_list: z.array(z.email().max(320)).min(1).max(200),
    campaign_schedule: ScheduleSchema.optional(),
    daily_limit: z.number().int().min(1).max(10_000).default(DEFAULT_DAILY_LIMIT),
    stop_on_reply: z.boolean().default(true),
    job_id: UUID.nullish(),
    list_id: UUID.nullish(),
    no_location_sibling: z.boolean().optional(),
  })
  .refine((v) => !!v.template_id || !!v.sequences, { message: 'template_id or sequences is required', path: ['template_id'] })

export type NewCampaignInputT = z.infer<typeof NewCampaignInput>

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Mon–Fri 09:00–17:00 America/Chicago" (first schedule; "+1 more" when there are others). */
export function scheduleSummary(schedule: unknown): string {
  const parsed = ScheduleSchema.safeParse(schedule)
  if (!parsed.success) return 'No schedule'
  const s = parsed.data.schedules[0]
  const on = Object.entries(s.days)
    .filter(([, v]) => v)
    .map(([k]) => Number(k))
    .sort((a, b) => a - b)
  const contiguous = on.length > 2 && on.every((d, i) => i === 0 || d === on[i - 1] + 1)
  const days = !on.length ? 'no days' : contiguous ? `${DAY[on[0]]}–${DAY[on[on.length - 1]]}` : on.map((d) => DAY[d]).join(', ')
  const more = parsed.data.schedules.length > 1 ? ` (+${parsed.data.schedules.length - 1} more)` : ''
  return `${days} ${s.timing.from}–${s.timing.to} ${s.timezone}${more}`
}

export function newCampaignSummary(p: Record<string, unknown>): string {
  const parts = [`New campaign “${String(p.name ?? '')}”`]
  if (typeof p.vertical_name === 'string' && p.vertical_name) parts[0] += ` (${p.vertical_name})`
  const inboxes = Array.isArray(p.email_list) ? p.email_list.length : 0
  const details = [
    typeof p.template_name === 'string' && p.template_name ? `template ${p.template_name}` : 'custom copy',
    `${inboxes} inbox${inboxes === 1 ? '' : 'es'}`,
    `${p.daily_limit}/day`,
    scheduleSummary(p.campaign_schedule),
  ]
  let out = `${parts[0]} — ${details.join(', ')}. Created as a draft, not launched.`
  const nl = p.no_location as { name?: unknown } | undefined
  if (nl && typeof nl.name === 'string') out += ` Also creates “${nl.name}” for leads with no city.`
  if (typeof p.job_label === 'string' && p.job_label) out += ` Then used for ${p.job_label}.`
  return out
}

const isObj = (v: Json | undefined): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v)

/** What the executor reads must be there and well-formed; null when it is. */
export function newCampaignPayloadError(p: Record<string, Json>): string | null {
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 200) return 'payload.name must be 1–200 characters'
  if (p.name_key !== p.name.trim().toLowerCase()) return 'payload.name_key must be the lowercased name'
  if (!SequencesSchema.safeParse(p.sequences).success) return 'payload.sequences must be a non-empty sequence'
  if (!Array.isArray(p.email_list) || !p.email_list.length || !p.email_list.every((e) => typeof e === 'string' && e.includes('@'))) return 'payload.email_list needs at least one inbox'
  if (!ScheduleSchema.safeParse(p.campaign_schedule).success) return 'payload.campaign_schedule is invalid'
  if (typeof p.daily_limit !== 'number' || !Number.isInteger(p.daily_limit) || p.daily_limit < 1) return 'payload.daily_limit must be a positive integer'
  if (typeof p.stop_on_reply !== 'boolean') return 'payload.stop_on_reply must be a boolean'
  if (p.vertical_id !== undefined && (typeof p.vertical_id !== 'string' || !UUID.safeParse(p.vertical_id).success)) return 'payload.vertical_id must be a uuid'
  if (p.no_location !== undefined) {
    if (!isObj(p.no_location) || typeof p.no_location.name !== 'string' || !SequencesSchema.safeParse(p.no_location.sequences).success) {
      return 'payload.no_location needs a name and sequences'
    }
  }
  return null
}
