/**
 * Edge-safe (middleware) half of the `lume_op` cookie: Web Crypto only, no
 * `node:crypto`, no `server-only`, no supabase-js. `cookie.ts` signs with
 * Node's HMAC; this verifies the same `<operator id>.<base64url HMAC-SHA256>`
 * and asks PostgREST whether that operator is still live.
 */

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SIG_RE = /^[A-Za-z0-9_-]{43}$/

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The operator id a `lume_op` value vouches for, or null. `crypto.subtle.verify` compares in constant time. */
export async function verifyOperatorCookieWeb(value: string | null | undefined, secret: string | null | undefined): Promise<string | null> {
  if (!value || !secret) return null
  const dot = value.indexOf('.')
  if (dot <= 0) return null
  const id = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  if (!ID_RE.test(id) || !SIG_RE.test(sig)) return null
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify('HMAC', key, fromBase64url(sig), enc.encode(id))
  return ok ? id : null
}

/**
 * Is this operator revoked (or deleted)? true / false, or null when the
 * lookup itself failed (callers fail open: a DB blip must not lock the owner
 * out; the deleted auth.sessions rows are the hard revocation).
 */
export async function isOperatorRevoked(id: string): Promise<boolean | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('[operators/revocation] missing Supabase URL or service key')
    return null
  }
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/lume_operators?select=revoked_at&id=eq.${id}`, {
      headers: { apikey: key, authorization: `Bearer ${key}`, accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) {
      console.error('[operators/revocation] lookup failed:', res.status)
      return null
    }
    const rows = (await res.json()) as Array<{ revoked_at: string | null }>
    return rows.length === 0 || !!rows[0].revoked_at
  } catch (err) {
    console.error('[operators/revocation] lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}
