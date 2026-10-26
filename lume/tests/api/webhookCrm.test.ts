import { beforeEach, describe, expect, it, vi } from 'vitest'

const logEvent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/service', () => ({ logEvent, isDbError: () => false }))
const ingestInstantlyEvent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/crm/ingest', () => ({ ingestInstantlyEvent }))

import { POST } from '@/app/api/webhooks/instantly/route'

const post = (body: unknown, secret = 's3cret') =>
  new Request(`http://localhost/api/webhooks/instantly?secret=${secret}`, { method: 'POST', body: JSON.stringify(body) })
const BODY = { event_type: 'reply_received', campaign_id: 'c1', lead_email: 'a@b.co', email_id: 'e1' }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INSTANTLY_WEBHOOK_SECRET = 's3cret'
  logEvent.mockResolvedValue({ id: 1 })
  ingestInstantlyEvent.mockResolvedValue(null)
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
