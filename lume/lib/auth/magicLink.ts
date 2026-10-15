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
