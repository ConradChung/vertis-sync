import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The `lume_op` cookie: `<operator id>.<hmac>`, HMAC-SHA256 of the id keyed
 * with `LUME_INTERNAL_SECRET`, base64url. It only says which Grok Bot holds
 * this owner session (attribution); the session itself is Supabase's. Pure.
 */

export const OPERATOR_COOKIE = 'lume_op'

/** Long-lived like the Supabase session it rides with; revocation is checked on every read. */
export const OPERATOR_COOKIE_MAX_AGE = 400 * 24 * 60 * 60

export const OPERATOR_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function mac(id: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(id).digest()
}

/** `<id>.<hmac>`; throws without a secret (callers fail closed). */
export function signOperatorCookie(id: string, secret: string | null | undefined): string {
  if (!secret) throw new Error('LUME_INTERNAL_SECRET is not set')
  return `${id}.${mac(id, secret).toString('base64url')}`
}

/** The operator id a cookie value vouches for, or null (missing, malformed, bad HMAC, no secret). */
export function verifyOperatorCookie(value: string | null | undefined, secret: string | null | undefined): string | null {
  if (!value || !secret) return null
  const dot = value.indexOf('.')
  if (dot <= 0) return null
  const id = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  if (!ID_RE.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null
  const presented = Buffer.from(sig, 'base64url')
  const expected = mac(id, secret)
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null
  return id
}

/** One cookie's value from a `Cookie` request header. */
export function cookieFromHeader(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim()
      try {
        return decodeURIComponent(raw)
      } catch {
        return raw
      }
    }
  }
  return null
}
