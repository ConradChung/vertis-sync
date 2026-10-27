import { NextResponse } from 'next/server'
import { cookieFromHeader, OPERATOR_COOKIE } from '@/lib/operators/cookie'

/**
 * Policy guards for Grok Bot operators.
 *
 * What these are NOT: a security boundary. Every Grok Bot signs in with an
 * operator key that mints a full owner Supabase session (the owner's
 * decision); a bot that dropped its `lume_op` cookie would be
 * indistinguishable from the owner. The cookie is attribution (who decided)
 * plus a policy guard that keeps well-behaved bots inside their role:
 *  - vertical bots cannot mint keys or create / change verticals; only the
 *    master bot (through the agent's issue_operator_key approval) or the
 *    owner can (`nonMasterOperatorForbidden`);
 *  - Settings' own mint / revoke routes take the owner's browser only, no
 *    `lume_op` cookie at all (`operatorCookieForbidden`).
 * The real limits are the hard caps (Apify $20, Leadsfriday minimums) and
 * revocation, which signs a bot out at once.
 */

/** The fixed refusal for a vertical bot asking for a key or a vertical change. */
export const MASTER_ONLY_ERROR = 'only the master bot or owner can issue keys or manage verticals'

/** 403 for a signed-in operator that is not the master; null for the owner or the master. */
export function nonMasterOperatorForbidden(op: { is_master: boolean } | null): NextResponse | null {
  if (!op || op.is_master) return null
  return NextResponse.json({ error: 'master_only', message: MASTER_ONLY_ERROR }, { status: 403 })
}

/** Settings' mint / revoke: any `lume_op` cookie (valid or not) is a 403. */
export function operatorCookieForbidden(req: Request): NextResponse | null {
  if (!cookieFromHeader(req.headers.get('cookie'), OPERATOR_COOKIE)) return null
  return NextResponse.json({ error: 'operator_forbidden' }, { status: 403 })
}

/** The full sign-in link for a raw key (`${origin}/auth/operator?k=…`). */
export function signInUrl(origin: string, rawKey: string): string {
  return `${origin.replace(/\/+$/, '')}/auth/operator?k=${encodeURIComponent(rawKey)}`
}
