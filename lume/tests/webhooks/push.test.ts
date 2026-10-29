import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildPush, checkWebhookUrl, maskSecret, pushSummary, signBody, signatureHeaders, verifySignature } from '@/lib/webhooks/push'

describe('push payload', () => {
  it('is exactly { type, vertical, item_id, summary, link }', () => {
    const p = buildPush({ type: 'positive_reply', vertical: 'Roofers', item_id: 'u-1', summary: 'Positive reply from Ada (Acme)', link: 'https://lume.test/operator' })
    expect(Object.keys(p).sort()).toEqual(['item_id', 'link', 'summary', 'type', 'vertical'])
  })

  it('summaries carry a name and company at most, never an address', () => {
    expect(pushSummary('positive_reply', { name: 'Ada Lovelace', company: 'Acme' })).toBe('New positive reply from Ada Lovelace (Acme). Check /operator.')
    expect(pushSummary('draft_awaiting', { name: null, company: null })).toBe('A reply draft awaits approval for a lead. Check /operator.')
    expect(pushSummary('needs_confirmation', { kind: 'pause_campaign' })).toBe('New item needs confirmation: pause campaign. Check /operator.')
    expect(pushSummary('positive_reply', { name: 'ada@acme.com', company: 'Acme <ceo@acme.com>' })).not.toMatch(/@/)
    expect(pushSummary('test', {})).toMatch(/test/i)
  })

  it('caps the summary length', () => {
    expect(pushSummary('positive_reply', { name: 'x'.repeat(500), company: 'y'.repeat(500) }).length).toBeLessThanOrEqual(300)
  })
})

describe('HMAC-SHA256 signature', () => {
  const secret = 's'.repeat(32)
  const body = '{"type":"test"}'
  it('signs "<timestamp>.<body>" and puts it in X-Lume-Signature', () => {
    const want = createHmac('sha256', secret).update(`1700000000.${body}`).digest('hex')
    expect(signBody(secret, body, 1700000000)).toBe(want)
    const h = signatureHeaders(secret, body, 'test', 1700000000, 'd-1')
    expect(h).toMatchObject({ 'Content-Type': 'application/json', 'X-Lume-Timestamp': '1700000000', 'X-Lume-Signature': `sha256=${want}`, 'X-Lume-Event': 'test', 'X-Lume-Delivery': 'd-1' })
  })

  it('verifies in constant time, rejects a changed body, a wrong secret or an old timestamp', () => {
    const h = signatureHeaders(secret, body, 'test', 1700000000, 'd-1')
    const now = 1700000000 + 60
    expect(verifySignature(secret, body, h['X-Lume-Timestamp'], h['X-Lume-Signature'], now)).toBe(true)
    expect(verifySignature(secret, body + ' ', h['X-Lume-Timestamp'], h['X-Lume-Signature'], now)).toBe(false)
    expect(verifySignature('t'.repeat(32), body, h['X-Lume-Timestamp'], h['X-Lume-Signature'], now)).toBe(false)
    expect(verifySignature(secret, body, h['X-Lume-Timestamp'], h['X-Lume-Signature'], 1700000000 + 3600)).toBe(false)
    expect(verifySignature(secret, body, h['X-Lume-Timestamp'], 'sha256=zz', now)).toBe(false)
  })
})

describe('webhook settings', () => {
  it('only public https URLs', () => {
    expect(checkWebhookUrl('https://api.x.ai/hooks/abc')).toBeNull()
    expect(checkWebhookUrl('http://api.x.ai/hooks/abc')).toBe('https_only')
    expect(checkWebhookUrl('https://user:pw@api.x.ai/h')).toBe('no_credentials')
    for (const u of ['https://localhost/h', 'https://127.0.0.1/h', 'https://10.0.0.2/h', 'https://[::1]/h', 'https://box.internal/h', 'https://a.local/h']) {
      expect(checkWebhookUrl(u)).toBe('private_host')
    }
    expect(checkWebhookUrl('not a url')).toBe('invalid_url')
  })

  it('masks the secret to its last 4 characters', () => {
    expect(maskSecret('abcdefghijklmnopqrstuvwxyz')).toBe('••••wxyz')
  })
})
