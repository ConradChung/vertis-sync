/**
 * The one predicate that decides who may use Lume.
 *
 * Pure so it can be unit-tested and reused by the middleware and route
 * guards. Case-insensitive; never passes when either side is missing, so an
 * unset `LUME_ALLOWED_EMAIL` fails closed instead of open.
 */
export function isOwner(email: string | undefined, allowed: string | undefined): boolean {
  const a = email?.trim().toLowerCase()
  const b = allowed?.trim().toLowerCase()
  if (!a || !b) return false
  return a === b
}
