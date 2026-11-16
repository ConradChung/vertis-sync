import { isOwner } from '@/lib/auth/isOwner'

// Deliberately loose: just enough to refuse junk before it reaches isOwner.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Decision for `POST /api/auth/magic-link`: Supabase is contacted only when
 * the requested address is the owner's. Pure, so the route stays thin and
 * this stays unit-tested. Fails closed on a missing allowed email.
 */
export function shouldSendMagicLink(email: string | undefined, allowed: string | undefined): boolean {
  if (!email || !EMAIL_SHAPE.test(email.trim())) return false
  return isOwner(email, allowed)
}

export type MagicLinkAudience = 'owner' | 'portal' | null

/**
 * Who a `/login` magic-link request is for: the owner, an active client-portal
 * user (looked up only when the address is not the owner's), or nobody. The
 * route answers `{ ok: true }` in every case, so this never becomes an oracle.
 */
export async function magicLinkAudience(
  email: string | undefined,
  allowed: string | undefined,
  isPortalUser: (email: string) => Promise<boolean>
): Promise<MagicLinkAudience> {
  if (!email || !EMAIL_SHAPE.test(email.trim())) return null
  if (isOwner(email, allowed)) return 'owner'
  return (await isPortalUser(email.trim().toLowerCase())) ? 'portal' : null
}
