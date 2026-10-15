import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Constant-time comparison of a presented secret against the expected one.
 *
 * Both sides are hashed first so the comparison runs over equal-length
 * buffers and leaks nothing about the expected value's length. Missing or
 * empty values never match, so an unset env var fails closed.
 */
export function secretMatches(
  presented: string | null | undefined,
  expected: string | null | undefined
): boolean {
  if (!presented || !expected) return false
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}
