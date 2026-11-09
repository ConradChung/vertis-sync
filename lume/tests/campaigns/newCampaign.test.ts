import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Json } from '@/lib/db/types'

// Every side effect is mocked: no DB, no Instantly, no Telegram.
const write = vi.hoisted(() => ({ createCampaign: vi.fn(), createCampaignFrom: vi.fn(), getCampaignDetail: vi.fn() }))
vi.mock('@/lib/adapters/instantlyWrite', () => write)
const read = vi.hoisted(() => ({ isInstantlyConfigured: vi.fn(), listAccounts: vi.fn(), listCampaigns: vi.fn(), listCampaignSetups: vi.fn() }))
vi.mock('@/lib/adapters/instantly', () => read)
const svc = vi.hoisted(() => ({ pickCampaign: vi.fn(), setNoLocationCampaign: vi.fn(), logEvent: vi.fn() }))
vi.mock('@/lib/db/service', () => ({ ...svc, CAMPAIGN_CHOICE_STATUSES: ['awaiting_campaign', 'choosing_campaign'], DbError: class extends Error {} }))
const ops = vi.hoisted(() => ({ getVertical: vi.fn(), updateVertical: vi.fn() }))
vi.mock('@/lib/operators/store', () => ops)
const tg = vi.hoisted(() => ({ editMessage: vi.fn() }))
vi.mock('@/lib/adapters/telegram', () => tg)
const data = vi.hoisted(() => ({ loadVerticals: vi.fn(), loadTemplates: vi.fn() }))
vi.mock('@/lib/campaigns/suggestData', () => data)
const jobRow = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }))
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: jobRow.value, error: null }) }
      return q
    },
  }),
}))

import { executeNewCampaign } from '@/lib/campaigns/newCampaignExec'
import { buildNewCampaign } from '@/lib/campaigns/newCampaign'
import { DEFAULT_SCHEDULE, NewCampaignInput, newCampaignPayloadError, newCampaignSummary, scheduleSummary } from '@/lib/campaigns/newCampaignPayload'

const VID = 'aaaaaaaa-0000-4000-8000-000000000001'
const TID = 'bbbbbbbb-0000-4000-8000-000000000001'
const TID_NL = 'bbbbbbbb-0000-4000-8000-000000000002'
const JOB = '16f26ffc-f8e5-47a5-9e1b-7532f61dad75'
const SEQ = [{ steps: [{ type: 'email', delay: 3, variants: [{ subject: 'Owners in {{location}}', body: 'hi' }, { subject: 'Quick one', body: 'hi' }] }] }]
const SEQ_ALL_LOC = [{ steps: [{ variants: [{ subject: 'In {{location}}', body: 'hi' }] }] }]
const SCHED = { schedules: [{ name: 'Weekdays', timing: { from: '09:00', to: '17:00' }, days: { '1': true, '2': true, '3': true, '4': true, '5': true }, timezone: 'America/Chicago' }] }

const payload = (over: Record<string, Json> = {}): Record<string, Json> => ({
  name: 'Kaspen — PM owners — Nov 2026',
  name_key: 'kaspen — pm owners — nov 2026',
  sequences: SEQ,
  email_list: ['a@send.com', 'b@send.com'],
  campaign_schedule: SCHED,
  daily_limit: 50,
  stop_on_reply: true,
  vertical_id: VID,
  vertical_name: 'Kaspen / Zenport',
  summary: 's',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  write.createCampaign.mockImplementation(async (b: { name: string }) => ({ id: b.name.includes('No Location') ? 'camp-nl' : 'camp-new', name: b.name }))
  ops.getVertical.mockResolvedValue({ id: VID, name: 'Kaspen / Zenport', campaign_ids: ['old'], archived_at: null })
  ops.updateVertical.mockResolvedValue({})
  svc.logEvent.mockResolvedValue(null)
  read.isInstantlyConfigured.mockReturnValue(true)
  read.listAccounts.mockResolvedValue([{ email: 'a@send.com' }, { email: 'B@send.com' }])
  read.listCampaigns.mockResolvedValue([{ id: 'c1', name: 'Kaspen' }])
  data.loadVerticals.mockResolvedValue([{ id: VID, name: 'Kaspen / Zenport', campaign_ids: [], keywords: [] }])
  data.loadTemplates.mockResolvedValue([
    { id: TID, name: 'Zenport Campaign', vertical_id: VID, sequences: SEQ, description: null },
    { id: TID_NL, name: 'Zenport Campaign — No Location', vertical_id: VID, sequences: [{ steps: [{ variants: [{ subject: 'Owners', body: 'x' }] }] }], description: null },
  ])
  jobRow.value = null
})

describe('payload', () => {
  it('input: template or sequences, 1–200 char name, inboxes required', () => {
    expect(NewCampaignInput.safeParse({ name: 'x', template_id: TID, email_list: ['a@b.co'] }).success).toBe(true)
    expect(NewCampaignInput.safeParse({ name: 'x', email_list: ['a@b.co'] }).success).toBe(false)
    expect(NewCampaignInput.safeParse({ name: '', template_id: TID, email_list: ['a@b.co'] }).success).toBe(false)
    expect(NewCampaignInput.safeParse({ name: 'x'.repeat(201), template_id: TID, email_list: ['a@b.co'] }).success).toBe(false)
    expect(NewCampaignInput.safeParse({ name: 'x', template_id: TID, email_list: [] }).success).toBe(false)
    expect(NewCampaignInput.parse({ name: 'x', template_id: TID, email_list: ['a@b.co'] })).toMatchObject({ daily_limit: 50, stop_on_reply: true })
  })

  it('executor fields are re-checked', () => {
    expect(newCampaignPayloadError(payload())).toBeNull()
    expect(newCampaignPayloadError(payload({ name_key: 'other' }))).toMatch(/name_key/)
    expect(newCampaignPayloadError(payload({ sequences: [] }))).toMatch(/sequences/)
    expect(newCampaignPayloadError(payload({ email_list: [] }))).toMatch(/inbox/)
    expect(newCampaignPayloadError(payload({ campaign_schedule: { schedules: [] } }))).toMatch(/schedule/)
    expect(newCampaignPayloadError(payload({ daily_limit: 0 }))).toMatch(/daily_limit/)
    expect(newCampaignPayloadError(payload({ no_location: { name: 'x' } }))).toMatch(/no_location/)
  })

  it('summary says draft, not launched', () => {
    expect(scheduleSummary(DEFAULT_SCHEDULE)).toBe('Mon–Fri 09:00–17:00 America/Chicago')
    const s = newCampaignSummary({ ...payload(), template_name: 'Zenport Campaign', no_location: { name: 'N — No Location' }, job_label: 'leadsfriday-4445.csv' })
    expect(s).toBe(
      'New campaign “Kaspen — PM owners — Nov 2026” (Kaspen / Zenport) — template Zenport Campaign, 2 inboxes, 50/day, Mon–Fri 09:00–17:00 America/Chicago. Created as a draft, not launched. Also creates “N — No Location” for leads with no city. Then used for leadsfriday-4445.csv.'
    )
  })
})

describe('executeNewCampaign', () => {
  it('POSTs the confirmed snapshot once, never activates, tags the campaign', async () => {
    const out = await executeNewCampaign(payload())
    expect(write.createCampaign).toHaveBeenCalledTimes(1)
    expect(write.createCampaign).toHaveBeenCalledWith({
      name: 'Kaspen — PM owners — Nov 2026',
      email_list: ['a@send.com', 'b@send.com'],
      campaign_schedule: SCHED,
      daily_limit: 50,
      stop_on_reply: true,
      sequences: SEQ,
    })
    expect(write.createCampaignFrom).not.toHaveBeenCalled()
    expect(ops.updateVertical).toHaveBeenCalledWith(VID, { campaign_ids: ['old', 'camp-new'] })
    expect(svc.pickCampaign).not.toHaveBeenCalled()
    expect(out).toEqual({ campaign_id: 'camp-new', name: 'Kaspen — PM owners — Nov 2026', status: 'draft', tagged: 'Kaspen / Zenport' })
  })

  it('job still awaiting a campaign → picked for it; the sibling takes its city-less leads', async () => {
    svc.pickCampaign.mockResolvedValue({ prompt_message_id: null })
    svc.setNoLocationCampaign.mockResolvedValue('ok')
    const out = await executeNewCampaign(payload({ job_id: JOB, no_location: { name: 'K — No Location', sequences: [{ steps: [{ variants: [{ subject: 'a', body: 'b' }] }] }] } }))
    expect(write.createCampaign).toHaveBeenCalledTimes(2)
    expect(svc.pickCampaign).toHaveBeenCalledWith(JOB, { id: 'camp-new', name: 'Kaspen — PM owners — Nov 2026' })
    expect(svc.setNoLocationCampaign).toHaveBeenCalledWith(JOB, { id: 'camp-nl', name: 'K — No Location' })
    expect(ops.updateVertical).toHaveBeenCalledWith(VID, { campaign_ids: ['old', 'camp-new', 'camp-nl'] })
    expect(out).toMatchObject({ picked_for_job: true, no_location_set: true, no_location_campaign_id: 'camp-nl' })
  })

  it('job already moved on → not picked, campaign still created', async () => {
    svc.pickCampaign.mockResolvedValue(false)
    const out = await executeNewCampaign(payload({ job_id: JOB }))
    expect(out).toMatchObject({ campaign_id: 'camp-new', picked_for_job: false })
    expect(svc.logEvent).not.toHaveBeenCalled()
  })

  it('a failed sibling is reported, the main campaign stays', async () => {
    write.createCampaign.mockResolvedValueOnce({ id: 'camp-new', name: 'n' }).mockRejectedValueOnce(new Error('Instantly 400'))
    const out = await executeNewCampaign(payload({ no_location: { name: 'K — No Location', sequences: SEQ } }))
    expect(out).toMatchObject({ campaign_id: 'camp-new', no_location_error: 'Instantly 400' })
  })

  it('the main POST failing throws (the action fails)', async () => {
    write.createCampaign.mockRejectedValue(new Error('Instantly 500'))
    await expect(executeNewCampaign(payload())).rejects.toThrow('Instantly 500')
    expect(ops.updateVertical).not.toHaveBeenCalled()
  })
})

describe('buildNewCampaign', () => {
  const input = { name: 'Kaspen — PM owners — Nov 2026', vertical_id: VID, template_id: TID, email_list: ['A@send.com', 'b@send.com'], daily_limit: 40 }

  it('freezes the template copy, lowercases inboxes, defaults the schedule', async () => {
    const b = await buildNewCampaign(input)
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.kind).toBe('new_campaign')
    expect(b.payload).toMatchObject({
      name: input.name,
      name_key: input.name.toLowerCase(),
      sequences: SEQ,
      email_list: ['a@send.com', 'b@send.com'],
      campaign_schedule: DEFAULT_SCHEDULE,
      daily_limit: 40,
      stop_on_reply: true,
      vertical_id: VID,
      vertical_name: 'Kaspen / Zenport',
      template_id: TID,
      template_name: 'Zenport Campaign',
    })
    expect(b.payload.summary).toMatch(/Created as a draft, not launched/)
  })

  it('refuses unknown inboxes, template, tag, a taken name, and Instantly off', async () => {
    expect(await buildNewCampaign({ ...input, email_list: ['z@nope.com'] })).toMatchObject({ ok: false, status: 400, error: 'unknown_inboxes', problems: ['z@nope.com'] })
    expect(await buildNewCampaign({ ...input, template_id: TID_NL.replace('2', '9') })).toMatchObject({ ok: false, error: 'unknown_template' })
    expect(await buildNewCampaign({ ...input, vertical_id: TID })).toMatchObject({ ok: false, error: 'unknown_vertical' })
    expect(await buildNewCampaign({ ...input, name: 'kaspen' })).toMatchObject({ ok: false, status: 409, error: 'name_taken' })
    expect(await buildNewCampaign({ ...input, name: '' })).toMatchObject({ ok: false, status: 400, error: 'invalid_payload' })
    read.isInstantlyConfigured.mockReturnValue(false)
    expect(await buildNewCampaign(input)).toMatchObject({ ok: false, error: 'instantly_not_configured' })
  })

  it('No-Location sibling: strips {{location}} variants, else the tag’s No-Location template', async () => {
    const b = await buildNewCampaign({ ...input, no_location_sibling: true })
    expect(b.ok && b.payload.no_location).toEqual({ name: `${input.name} — No Location`, sequences: [{ steps: [{ type: 'email', delay: 3, variants: [{ subject: 'Quick one', body: 'hi' }] }] }] })
    data.loadTemplates.mockResolvedValue([
      { id: TID, name: 'Zenport Campaign', vertical_id: VID, sequences: SEQ_ALL_LOC, description: null },
      { id: TID_NL, name: 'Zenport Campaign — No Location', vertical_id: VID, sequences: [{ steps: [{ variants: [{ subject: 'Owners', body: 'x' }] }] }], description: null },
    ])
    const c = await buildNewCampaign({ ...input, no_location_sibling: true })
    expect(c.ok && c.payload.no_location).toMatchObject({ template_name: 'Zenport Campaign — No Location' })
  })

  it('job_id: must exist; the summary says it will be used for the job while it awaits a campaign', async () => {
    expect(await buildNewCampaign({ ...input, job_id: JOB })).toMatchObject({ ok: false, status: 404, error: 'unknown_job' })
    jobRow.value = { filename: 'leadsfriday-4445.csv', display_name: null, total_rows: 5255, created_at: '2026-11-06T02:28:43Z', instantly_status: 'awaiting_campaign' }
    const b = await buildNewCampaign({ ...input, job_id: JOB.toUpperCase() })
    expect(b.ok && b.payload).toMatchObject({ job_id: JOB, job_awaiting_campaign: true })
    expect(b.ok && b.payload.summary).toMatch(/Then used for leadsfriday-4445\.csv\./)
  })
})
