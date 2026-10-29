import { beforeEach, describe, expect, it, vi } from 'vitest'

const logEvent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/service', () => ({ logEvent, isDbError: () => false }))
const ingestInstantlyEvent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/crm/ingest', () => ({ ingestInstantlyEvent }))
const inbox = vi.hoisted(() => ({ notePositiveReply: vi.fn() }))
vi.mock('@/lib/inbox/replies', () => inbox)
const emails = vi.hoisted(() => ({ listEmails: vi.fn() }))
vi.mock('@/lib/adapters/instantlyEmails', () => emails)

import { POST } from '@/app/api/webhooks/instantly/route'

const post = (body: unknown, secret = 's3cret') =>
  new Request(`http://localhost/api/webhooks/instantly?secret=${secret}`, { method: 'POST', body: JSON.stringify(body) })
const BODY = { event_type: 'reply_received', campaign_id: 'c1', lead_email: 'a@b.co', email_id: 'e1' }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INSTANTLY_WEBHOOK_SECRET = 's3cret'
  logEvent.mockResolvedValue({ id: 1 })
  ingestInstantlyEvent.mockResolvedValue(null)
  inbox.notePositiveReply.mockResolvedValue(true)
  emails.listEmails.mockResolvedValue({ emails: [], next: null, stale: false })
  process.env.INSTANTLY_API_KEY = 'k'
})

describe('Instantly webhook → CRM hook', () => {
  it('passes the mapped event (with its webhook_id) to the CRM', async () => {
    const res = await POST(post(BODY))
    expect(await res.json()).toEqual({ ok: true, duplicate: false })
    expect(ingestInstantlyEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'reply', campaign_id: 'c1', lead_email: 'a@b.co', webhook_id: 'instantly:reply_received:e1' }))
  })

  it('still runs for a duplicate delivery (CRM dedupes on webhook_id) and still answers duplicate:true', async () => {
    logEvent.mockResolvedValue(null)
    const res = await POST(post(BODY))
    expect(await res.json()).toEqual({ ok: true, duplicate: true })
    expect(ingestInstantlyEvent).toHaveBeenCalledTimes(1)
  })

  it('a CRM failure never changes the 200', async () => {
    ingestInstantlyEvent.mockRejectedValue(new Error('crm down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(post(BODY))
    expect(res.status).toBe(200)
    spy.mockRestore()
  })

  it('bad secret: 401 and nothing reaches the CRM', async () => {
    const res = await POST(post(BODY, 'nope'))
    expect(res.status).toBe(401)
    expect(ingestInstantlyEvent).not.toHaveBeenCalled()
  })

  it('an events write failure is still a 500 (Instantly retries) and skips the CRM', async () => {
    logEvent.mockRejectedValue(new Error('db'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(post(BODY))
    expect(res.status).toBe(500)
    expect(ingestInstantlyEvent).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('Instantly webhook → positive replies (inbox manager 3a)', () => {
  const INTERESTED = {
    event_type: 'lead_interested', campaign_id: 'c1', lead_email: 'Ada@Acme.com', email_id: 'e9', email_account: 'frank@ours.com',
    reply_subject: 'Re: hi', reply_text: 'Yes, tell me more', timestamp: '2026-10-28T10:00:00.000Z',
  }

  it('lead_interested: the reply is recorded and alerted (webhook source)', async () => {
    const res = await POST(post(INTERESTED))
    expect(res.status).toBe(200)
    expect(inbox.notePositiveReply).toHaveBeenCalledWith({
      reply_to_uuid: 'e9', campaign_id: 'c1', lead_email: 'ada@acme.com', eaccount: 'frank@ours.com', subject: 'Re: hi',
      excerpt: 'Yes, tell me more', received_at: '2026-10-28T10:00:00.000Z', interest: 1, source: 'webhook',
    })
  })

  it('a plain reply_received is not positive on its own', async () => {
    await POST(post(BODY))
    expect(inbox.notePositiveReply).not.toHaveBeenCalled()
  })

  it('a reply_received carrying an interested status is', async () => {
    await POST(post({ ...BODY, lt_interest_status: 1 }))
    expect(inbox.notePositiveReply).toHaveBeenCalledWith(expect.objectContaining({ reply_to_uuid: 'e1', source: 'webhook' }))
  })

  it('no email id: looked up from the lead\'s newest received email', async () => {
    const noId: Record<string, unknown> = { ...INTERESTED }
    delete noId.email_id
    emails.listEmails.mockResolvedValue({ emails: [{ id: 'found-1', thread_id: 't', eaccount: 'frank@ours.com' }], next: null, stale: false })
    await POST(post(noId))
    expect(emails.listEmails).toHaveBeenCalledWith({ campaign_id: 'c1', lead: 'ada@acme.com', email_type: 'received', limit: 1 })
    expect(inbox.notePositiveReply).toHaveBeenCalledWith(expect.objectContaining({ reply_to_uuid: 'found-1' }))
  })

  it('no email id and nothing found: skipped (the poll catches it later), still 200', async () => {
    const noId: Record<string, unknown> = { ...INTERESTED }
    delete noId.email_id
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(post(noId))
    expect(res.status).toBe(200)
    expect(inbox.notePositiveReply).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('an alert failure never changes the 200', async () => {
    inbox.notePositiveReply.mockRejectedValue(new Error('feed down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await POST(post(INTERESTED))).status).toBe(200)
    spy.mockRestore()
  })
})
