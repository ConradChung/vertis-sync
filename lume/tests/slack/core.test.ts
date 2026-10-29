import { createHmac, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifySlackSignature, SLACK_MAX_SKEW_S } from '@/lib/slack/verify'
import { decryptToken, encryptToken, parseTokenKey } from '@/lib/slack/crypto'
import { signInstallLink, signState, verifyInstallLink, verifyState } from '@/lib/slack/installLink'
import { slackConfig, SLACK_BOT_SCOPES, slackRedirectUri } from '@/lib/slack/config'

const SECRET = 'signing-secret-123'
const sign = (body: string, ts: number, secret = SECRET) => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`
const KEY = randomBytes(32).toString('base64')

afterEach(() => vi.unstubAllEnvs())

describe('verifySlackSignature', () => {
  const now = 1_730_000_000
  it('accepts a v0 HMAC over the raw body inside the window', () => {
    const body = 'payload=%7B%22a%22%3A1%7D'
    expect(verifySlackSignature(body, { timestamp: String(now), signature: sign(body, now) }, SECRET, now)).toEqual({ ok: true })
  })
  it('refuses a wrong signature, another body or another secret', () => {
    const body = '{"type":"event_callback"}'
    expect(verifySlackSignature(body, { timestamp: String(now), signature: sign(body, now, 'other') }, SECRET, now)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifySlackSignature(body + ' ', { timestamp: String(now), signature: sign(body, now) }, SECRET, now)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifySlackSignature(body, { timestamp: String(now), signature: 'v0=zz' }, SECRET, now)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifySlackSignature(body, { timestamp: String(now), signature: 'v1=' + sign(body, now).slice(3) }, SECRET, now)).toEqual({ ok: false, reason: 'bad_signature' })
  })
  it('refuses a timestamp outside 5 minutes either way (replay)', () => {
    const body = '{}'
    const old = now - SLACK_MAX_SKEW_S - 1
    expect(verifySlackSignature(body, { timestamp: String(old), signature: sign(body, old) }, SECRET, now)).toEqual({ ok: false, reason: 'stale' })
    const future = now + SLACK_MAX_SKEW_S + 1
    expect(verifySlackSignature(body, { timestamp: String(future), signature: sign(body, future) }, SECRET, now)).toEqual({ ok: false, reason: 'stale' })
    expect(SLACK_MAX_SKEW_S).toBe(300)
  })
  it('refuses missing headers or a missing secret (fails closed)', () => {
    expect(verifySlackSignature('{}', { timestamp: null, signature: sign('{}', now) }, SECRET, now).ok).toBe(false)
    expect(verifySlackSignature('{}', { timestamp: String(now), signature: null }, SECRET, now).ok).toBe(false)
    expect(verifySlackSignature('{}', { timestamp: String(now), signature: sign('{}', now, '') }, '', now)).toEqual({ ok: false, reason: 'not_configured' })
    expect(verifySlackSignature('{}', { timestamp: 'abc', signature: sign('{}', now) }, SECRET, now)).toEqual({ ok: false, reason: 'stale' })
  })
})

describe('bot token encryption (AES-256-GCM, team id as associated data)', () => {
  it('round-trips and never contains the plaintext', () => {
    const enc = encryptToken('xoxb-123-secret', 'T123', KEY)
    expect(enc).toMatch(/^v1:[A-Za-z0-9_-]+$/)
    expect(enc).not.toContain('xoxb')
    expect(decryptToken(enc, 'T123', KEY)).toBe('xoxb-123-secret')
  })
  it('uses a fresh IV each time', () => {
    expect(encryptToken('xoxb-a', 'T1', KEY)).not.toBe(encryptToken('xoxb-a', 'T1', KEY))
  })
  it('a ciphertext moved to another team, tampered, or read with another key fails', () => {
    const enc = encryptToken('xoxb-a', 'T1', KEY)
    expect(() => decryptToken(enc, 'T2', KEY)).toThrow()
    const flipped = enc.slice(0, -2) + (enc.endsWith('A') ? 'BB' : 'AA')
    expect(() => decryptToken(flipped, 'T1', KEY)).toThrow()
    expect(() => decryptToken(enc, 'T1', randomBytes(32).toString('base64'))).toThrow()
  })
  it('the key is 32 bytes as base64 or hex; anything else is refused', () => {
    expect(parseTokenKey(randomBytes(32).toString('hex'))?.length).toBe(32)
    expect(parseTokenKey(KEY)?.length).toBe(32)
    expect(parseTokenKey('short')).toBeNull()
    expect(parseTokenKey('')).toBeNull()
    expect(() => encryptToken('xoxb-a', 'T1', 'short')).toThrow(/LUME_SLACK_TOKEN_KEY/)
  })
})

describe('install link and OAuth state', () => {
  const now = 1_730_000_000_000
  it('a signed link verifies until it expires', () => {
    const t = signInstallLink(KEY, { expiresAt: now + 60_000, nonce: 'n1' })
    expect(verifyInstallLink(t, KEY, now)).toEqual({ ok: true, nonce: 'n1', expiresAt: now + 60_000 })
    expect(verifyInstallLink(t, KEY, now + 60_001)).toEqual({ ok: false, reason: 'expired' })
  })
  it('a forged, altered or other-key link is refused', () => {
    const t = signInstallLink(KEY, { expiresAt: now + 60_000, nonce: 'n1' })
    expect(verifyInstallLink(t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), KEY, now).ok).toBe(false)
    expect(verifyInstallLink(t, randomBytes(32).toString('base64'), now).ok).toBe(false)
    expect(verifyInstallLink('garbage', KEY, now).ok).toBe(false)
    expect(verifyInstallLink('', KEY, now).ok).toBe(false)
  })
  it('a link is not a valid state and a state is not a valid link (separate purposes)', () => {
    const link = signInstallLink(KEY, { expiresAt: now + 60_000, nonce: 'n1' })
    const state = signState(KEY, { expiresAt: now + 60_000, nonce: 's1', link: 'n1' })
    expect(verifyState(link, KEY, now).ok).toBe(false)
    expect(verifyInstallLink(state, KEY, now).ok).toBe(false)
    expect(verifyState(state, KEY, now)).toEqual({ ok: true, nonce: 's1', link: 'n1', expiresAt: now + 60_000 })
  })
})

describe('slackConfig', () => {
  it('reports exactly which env vars are missing ("not configured")', () => {
    vi.stubEnv('SLACK_CLIENT_ID', '')
    vi.stubEnv('SLACK_CLIENT_SECRET', 'x')
    vi.stubEnv('SLACK_SIGNING_SECRET', '')
    vi.stubEnv('LUME_SLACK_TOKEN_KEY', 'bad')
    const c = slackConfig()
    expect(c.configured).toBe(false)
    expect(c.missing).toEqual(['SLACK_CLIENT_ID', 'SLACK_SIGNING_SECRET', 'LUME_SLACK_TOKEN_KEY'])
  })
  it('configured with all four', () => {
    vi.stubEnv('SLACK_CLIENT_ID', 'id')
    vi.stubEnv('SLACK_CLIENT_SECRET', 'sec')
    vi.stubEnv('SLACK_SIGNING_SECRET', 'sig')
    vi.stubEnv('LUME_SLACK_TOKEN_KEY', KEY)
    expect(slackConfig()).toMatchObject({ configured: true, missing: [] })
  })
  it('minimal scopes and the fixed redirect path', () => {
    expect(SLACK_BOT_SCOPES).toEqual(['chat:write', 'app_mentions:read', 'channels:read', 'groups:read'])
    vi.stubEnv('LUME_URL', 'https://lume-amber-alpha.vercel.app/')
    expect(slackRedirectUri('http://ignored')).toBe('https://lume-amber-alpha.vercel.app/api/slack/oauth/callback')
  })
})
