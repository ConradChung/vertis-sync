import 'server-only'
import { cookieFromHeader, OPERATOR_COOKIE, verifyOperatorCookie } from '@/lib/operators/cookie'
import { getOperator } from '@/lib/operators/store'
import type { Operator } from '@/lib/operators/types'

/** A Next cookie store (`await cookies()`); `delete` only works where Next allows writes. */
export interface CookieSource {
  get(name: string): { value: string } | undefined
  delete?(name: string): unknown
}

/**
 * The Grok Bot operator this request is signed in as, or null for the owner
 * themselves: no `lume_op` cookie, a bad HMAC, an unknown operator or a
 * revoked one. A revoked operator's cookie is cleared where the source allows
 * it (route handlers, server actions); in a server component the delete
 * throws and is ignored. Never throws for a cookie problem; a DB error is
 * logged and treated as "not an operator".
 */
export async function currentOperator(source: CookieSource | Request): Promise<Operator | null> {
  const isRequest = typeof Request !== 'undefined' && source instanceof Request
  const value = isRequest
    ? cookieFromHeader((source as Request).headers.get('cookie'), OPERATOR_COOKIE)
    : ((source as CookieSource).get(OPERATOR_COOKIE)?.value ?? null)
  const id = verifyOperatorCookie(value, process.env.LUME_INTERNAL_SECRET)
  if (!id) return null
  let op: Operator | null
  try {
    op = await getOperator(id)
  } catch (err) {
    console.error('[operators/session] getOperator failed:', err instanceof Error ? err.message : err)
    return null
  }
  if (op && !op.revoked_at) return op
  if (!isRequest) {
    try {
      ;(source as CookieSource).delete?.(OPERATOR_COOKIE)
    } catch {
      // read-only cookie store (server component render)
    }
  }
  return null
}
