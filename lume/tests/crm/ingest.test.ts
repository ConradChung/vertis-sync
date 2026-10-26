import { beforeEach, describe, expect, it, vi } from 'vitest'

const crm = vi.hoisted(() => ({
  ensureDeal: vi.fn(),
  addActivity: vi.fn(),
  setStage: vi.fn(),
  findLeadByEmail: vi.fn(),
}))
vi.mock('@/lib/crm/service', () => crm)
const logEvent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/service', () => ({ logEvent }))

import { mapInstantlyWebhook } from '@/lib/adapters/instantlyWebhook'
import { ingestGmailSend, ingestInstantlyEvent, ingestMuseEvent } from '@/lib/crm/ingest'

const CAMP = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
const DEAL = '5b7f2d1e-3c4a-4e8b-9f0a-1b2c3d4e5f60'
let stage = 'Contacted'

beforeEach(() => {
  vi.clearAllMocks()
  stage = 'Contacted'
  crm.findLeadByEmail.mockResolvedValue({ id: 7, first_name: 'Ada', last_name: 'L', company_name: 'Engines', location: 'London' })
  crm.ensureDeal.mockImplementation(async () => ({ id: DEAL, stage, name: 'Ada L', email: 'ada@example.com' }))
  crm.addActivity.mockResolvedValue({ id: 'act-1' })
  crm.setStage.mockImplementation(async () => stage)
  logEvent.mockResolvedValue({ id: 1 })
})

const hook = (event_type: string, extra: Record<string, unknown> = {}) =>
  mapInstantlyWebhook({ event_type, campaign_id: CAMP, lead_email: 'Ada@Example.com', email_id: 'em-1', timestamp: '2026-10-25T10:00:00Z', ...extra })

describe('Instantly webhook → CRM', () => {
  it('reply_received: activity (deduped on webhook_id) + auto-advance to Replied, logged to Agent activity', async () => {
    const out = await ingestInstantlyEvent(hook('reply_received', { reply_text: 'Sounds interesting' }))
    expect(crm.ensureDeal).toHaveBeenCalledWith(expect.objectContaining({ campaign_id: CAMP, email: 'ada@example.com', lead_id: 7, name: 'Ada L', company: 'Engines', city: 'London' }))
    expect(crm.addActivity).toHaveBeenCalledWith(
      expect.objectContaining({ deal_id: DEAL, kind: 'replied', source: 'instantly', dedupe_key: 'instantly:reply_received:em-1:2026-10-25T10:00:00Z', payload: expect.objectContaining({ reply_text: 'Sounds interesting' }) })
    )
    expect(crm.setStage).toHaveBeenCalledWith(DEAL, 'Replied', 'agent', null, expect.objectContaining({ auto: true, signal: 'replied' }))
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'lume.crm_stage_auto', source: 'lume', source_id: DEAL, campaign_id: CAMP }))
    expect(out).toEqual({ deal_id: DEAL, activity: true, advanced: { from: 'Contacted', to: 'Replied' } })
  })

  it('lead_interested advances to Interested; email_bounced to Bounced', async () => {
    await ingestInstantlyEvent(hook('lead_interested'))
    expect(crm.setStage).toHaveBeenLastCalledWith(DEAL, 'Interested', 'agent', null, expect.anything())
    await ingestInstantlyEvent(hook('email_bounced'))
    expect(crm.addActivity).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'bounced' }))
    expect(crm.setStage).toHaveBeenLastCalledWith(DEAL, 'Bounced', 'agent', null, expect.anything())
  })

  it('never moves backwards, never closes, never touches a Won deal', async () => {
    stage = 'Meeting booked'
    await ingestInstantlyEvent(hook('reply_received'))
    stage = 'Won'
    await ingestInstantlyEvent(hook('lead_interested'))
    await ingestInstantlyEvent(hook('email_bounced'))
    expect(crm.setStage).not.toHaveBeenCalled()
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('email_sent only records an activity', async () => {
    await ingestInstantlyEvent(hook('email_sent', { subject: 'Quick idea' }))
    expect(crm.addActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sent', payload: expect.objectContaining({ subject: 'Quick idea' }) }))
    expect(crm.setStage).not.toHaveBeenCalled()
  })

  it('a replayed delivery adds no activity but the (idempotent) stage check still runs', async () => {
    crm.addActivity.mockResolvedValue(null)
    stage = 'Replied' // already advanced by the first delivery
    const out = await ingestInstantlyEvent(hook('reply_received'))
    expect(out).toEqual({ deal_id: DEAL, activity: false, advanced: null })
    expect(crm.setStage).not.toHaveBeenCalled()
  })

  it('skips events without a campaign or email, and untracked types', async () => {
    expect(await ingestInstantlyEvent(mapInstantlyWebhook({ event_type: 'reply_received', lead_email: 'a@b.co' }))).toBeNull()
    expect(await ingestInstantlyEvent(mapInstantlyWebhook({ event_type: 'reply_received', campaign_id: CAMP }))).toBeNull()
    expect(await ingestInstantlyEvent(hook('campaign_completed'))).toBeNull()
    expect(crm.ensureDeal).not.toHaveBeenCalled()
  })

  it('a failing Agent-activity log does not undo the move', async () => {
    logEvent.mockRejectedValue(new Error('down'))
    const out = await ingestInstantlyEvent(hook('reply_received'))
    expect(out?.advanced).toEqual({ from: 'Contacted', to: 'Replied' })
  })
})

describe('Gmail / Muse adapters (not wired yet)', () => {
  it('Gmail out = sent activity only; in = reply that advances', async () => {
    await ingestGmailSend({ id: 'g1', campaign_id: 'gmail:recruiter', email: 'r@x.co', direction: 'out', subject: 'Hi' })
    expect(crm.addActivity).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'sent', source: 'gmail', dedupe_key: 'gmail:g1' }))
    expect(crm.setStage).not.toHaveBeenCalled()
    expect(crm.findLeadByEmail).not.toHaveBeenCalled()
    await ingestGmailSend({ id: 'g2', campaign_id: 'gmail:recruiter', email: 'r@x.co', direction: 'in', text: 'yes' })
    expect(crm.setStage).toHaveBeenCalledWith(DEAL, 'Replied', 'agent', null, expect.objectContaining({ source: 'gmail' }))
  })

  it('Muse: queued is ignored, sent records, replied advances', async () => {
    expect(await ingestMuseEvent({ id: 'm0', campaign_id: 'muse:auto-apply', email: 'j@x.co', kind: 'queued' })).toBeNull()
    await ingestMuseEvent({ id: 'm1', campaign_id: 'muse:auto-apply', email: 'j@x.co', kind: 'sent' })
    expect(crm.setStage).not.toHaveBeenCalled()
    await ingestMuseEvent({ id: 'm2', campaign_id: 'muse:auto-apply', email: 'j@x.co', kind: 'replied' })
    expect(crm.setStage).toHaveBeenCalledWith(DEAL, 'Replied', 'agent', null, expect.objectContaining({ source: 'muse' }))
  })
})
