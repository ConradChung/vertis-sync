import { createHmac, timingSafeEqual } from 'node:crypto'
import { derivedKey } from '@/lib/slack/crypto'

/**
 * Signed, expiring tokens (3g). Two purposes, each with its own derived key,
 * so one can never stand in for the other:
 *  - the install link the owner shares with a client
 *    (`/api/slack/install?t=<token>`; days, owner-generated);
 *  - the OAuth `state` (minutes), also set as an httpOnly cookie and compared
 *    on the callback, naming the link it came from.
 * Format: base64url(JSON) + '.' + base64url(HMAC-SHA256). Pure.
 */

type Verified<T> = ({ ok: true } & T) | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' }

function sign(purpose: string, rawKey: string, body: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(body)).toString('base64url')
  const mac = createHmac('sha256', derivedKey(rawKey, purpose)).update(data).digest('base64url')
  return `${data}.${mac}`
}

function verify(purpose: string, token: string | null | undefined, rawKey: string, nowMs: number): Verified<{ body: Record<string, unknown> }> {
  const m = /^([A-Za-z0-9_-]{8,2000})\.([A-Za-z0-9_-]{43})$/.exec(token ?? '')
  if (!m) return { ok: false, reason: 'malformed' }
  let key: Buffer
  try {
    key = derivedKey(rawKey, purpose)
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }
  const expected = createHmac('sha256', key).update(m[1]).digest()
  const presented = Buffer.from(m[2], 'base64url')
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { ok: false, reason: 'bad_signature' }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof body.exp !== 'number' || typeof body.n !== 'string') return { ok: false, reason: 'malformed' }
  if (nowMs > body.exp) return { ok: false, reason: 'expired' }
  return { ok: true, body }
}

export const INSTALL_LINK_DAYS_DEFAULT = 7
export const INSTALL_LINK_DAYS_MAX = 30
export const STATE_TTL_MS = 10 * 60_000

export function signInstallLink(rawKey: string, o: { expiresAt: number; nonce: string }): string {
  return sign('install-link', rawKey, { n: o.nonce, exp: o.expiresAt })
}

export function verifyInstallLink(token: string | null | undefined, rawKey: string, nowMs = Date.now()): Verified<{ nonce: string; expiresAt: number }> {
  const v = verify('install-link', token, rawKey, nowMs)
  return v.ok ? { ok: true, nonce: v.body.n as string, expiresAt: v.body.exp as number } : v
}

export function signState(rawKey: string, o: { expiresAt: number; nonce: string; link: string }): string {
  return sign('oauth-state', rawKey, { n: o.nonce, exp: o.expiresAt, l: o.link })
}

export function verifyState(token: string | null | undefined, rawKey: string, nowMs = Date.now()): Verified<{ nonce: string; link: string; expiresAt: number }> {
  const v = verify('oauth-state', token, rawKey, nowMs)
  if (!v.ok) return v
  if (typeof v.body.l !== 'string') return { ok: false, reason: 'malformed' }
  return { ok: true, nonce: v.body.n as string, link: v.body.l, expiresAt: v.body.exp as number }
}
