import { NextResponse } from 'next/server'
import { cookieFromHeader, OPERATOR_COOKIE } from '@/lib/operators/cookie'

/**
 * Minting or revoking operator keys: the owner's own browser session only.
 * Routes call `requireOwnerSession` (the agent's internal bearer is a 403)
 * and then this: any request carrying a `lume_op` cookie, valid or not, is a
 * 403 too, so a Grok Bot may view the keys but never mint or revoke one.
 */
export function operatorCookieForbidden(req: Request): NextResponse | null {
  if (!cookieFromHeader(req.headers.get('cookie'), OPERATOR_COOKIE)) return null
  return NextResponse.json({ error: 'operator_forbidden' }, { status: 403 })
}

/** The full sign-in link for a raw key (`${origin}/auth/operator?k=…`). */
export function signInUrl(origin: string, rawKey: string): string {
  return `${origin.replace(/\/+$/, '')}/auth/operator?k=${encodeURIComponent(rawKey)}`
}
