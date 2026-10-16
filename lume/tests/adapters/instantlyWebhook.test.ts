import { describe, expect, it } from 'vitest'
import { MAX_STRING, mapInstantlyWebhook, truncatePayload, webhookIdFor } from '@/lib/adapters/instantlyWebhook'

const base = { campaign_id: 'camp-1', campaign_name: 'Kaspen PM', lead_email: 'Maya@Northstar.com', timestamp: '2026-10-15T10:00:00Z' }

describe('mapInstantlyWebhook', () => {
  it.each([
    ['reply_received', 'reply', 'Reply from maya@northstar.com'],
    ['lead_interested', 'interested', 'Interested: maya@northstar.com'],
    ['email_bounced', 'bounce', 'Bounce: maya@northstar.com'],
    ['email_sent', 'sent', 'Sent to maya@northstar.com'],
    ['lead_meeting_booked', 'instantly.lead_meeting_booked', 'Instantly lead_meeting_booked: maya@northstar.com'],
  ])('%s → %s', (event_type, type, title) => {
    const ev = mapInstantlyWebhook({ ...base, event_type })
    expect(ev).toMatchObject({ type, title, source: 'instantly', campaign_id: 'camp-1', lead_email: 'maya@northstar.com' })
  })

  it('missing event_type → instantly.unknown, missing email → placeholder title', () => {
    const ev = mapInstantlyWebhook({ campaign_id: 'c' })
    expect(ev.type).toBe('instantly.unknown')
    expect(ev.lead_email).toBeNull()
    expect(ev.title).toBe('Instantly event')
    expect(mapInstantlyWebhook({ event_type: 'reply_received' }).title).toBe('Reply from unknown lead')
  })

  it('keeps the body as payload', () => {
    const ev = mapInstantlyWebhook({ ...base, event_type: 'reply_received', reply_text: 'hi', unibox_url: 'https://app.instantly.ai/x' })
    expect(ev.payload).toMatchObject({ reply_text: 'hi', unibox_url: 'https://app.instantly.ai/x', campaign_name: 'Kaspen PM' })
  })
})

describe('webhook_id (dedupe key)', () => {
  it("uses the payload's event id when present", () => {
    expect(webhookIdFor({ event_type: 'reply_received', event_id: 'evt_9', email_id: 'e1' })).toBe('instantly:reply_received:evt_9')
    expect(webhookIdFor({ id: 42 })).toBe('instantly:unknown:42')
    expect(webhookIdFor({ event_type: 'reply_received', email_id: 'm1', timestamp: '2026-10-15T10:00:00Z' })).toBe(
      'instantly:reply_received:m1:2026-10-15T10:00:00Z'
    )
    // a sent and a bounce for the same message must not dedupe each other
    expect(webhookIdFor({ event_type: 'email_sent', email_id: 'em_1' })).not.toBe(webhookIdFor({ event_type: 'email_bounced', email_id: 'em_1' }))
  })

  it('falls back to a stable hash of the body, independent of key order', () => {
    const a = webhookIdFor({ event_type: 'reply_received', lead_email: 'a@x.com', campaign_id: 'c' })
    const b = webhookIdFor({ campaign_id: 'c', lead_email: 'a@x.com', event_type: 'reply_received' })
    const c = webhookIdFor({ campaign_id: 'c', lead_email: 'b@x.com', event_type: 'reply_received' })
    expect(a).toMatch(/^instantly:sha256:[0-9a-f]{64}$/)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('payload truncation', () => {
  it('cuts reply_text and bodies over 2 KB, leaves short fields alone', () => {
    const long = 'x'.repeat(10_000)
    const ev = mapInstantlyWebhook({ ...base, event_type: 'reply_received', reply_text: long, reply_html: long, nested: { body: long } })
    const p = ev.payload as Record<string, unknown>
    expect((p.reply_text as string).length).toBe(MAX_STRING + 1)
    expect((p.reply_text as string).endsWith('…')).toBe(true)
    expect((p.reply_html as string).length).toBe(MAX_STRING + 1)
    expect(((p.nested as Record<string, string>).body).length).toBe(MAX_STRING + 1)
    expect(p.campaign_name).toBe('Kaspen PM')
  })

  it('bounds depth and array length', () => {
    expect(truncatePayload({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: null } } } })
    expect((truncatePayload(Array.from({ length: 80 }, (_, i) => i)) as number[]).length).toBe(50)
  })
})
