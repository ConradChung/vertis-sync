import { ptParts } from '@/lib/content/config'

/**
 * Slot rotation (pure). Tuesday is Proof, Wednesday is Owner view, Thursday
 * is Hand-raiser. The Hand-raiser alternates by ISO week: even weeks are the
 * "comment and I'll send the breakdown" post, odd weeks one story fully told.
 */

export const SLOTS = ['proof', 'owner_view', 'hand_raiser'] as const
export type Slot = (typeof SLOTS)[number]
export type Variant = 'breakdown' | 'story'
export const isSlot = (v: unknown): v is Slot => typeof v === 'string' && (SLOTS as readonly string[]).includes(v)

export const SLOT_LABEL: Record<Slot, string> = { proof: 'Proof', owner_view: 'Owner view', hand_raiser: 'Hand-raiser' }

/** The slot for a PT weekday, or null on days without a draft. */
export function slotForDay(now: Date): Slot | null {
  const { weekday } = ptParts(now)
  return weekday === 2 ? 'proof' : weekday === 3 ? 'owner_view' : weekday === 4 ? 'hand_raiser' : null
}

/** ISO 8601 week number of a YYYY-MM-DD date. */
export function isoWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
}

export function variantFor(slot: Slot, now: Date): Variant | null {
  if (slot !== 'hand_raiser') return null
  return isoWeek(ptParts(now).date) % 2 === 0 ? 'breakdown' : 'story'
}

/** Scheduled runs: only in the 6 AM PT hour (pg_cron fires at both 13:30 and 14:30 UTC to cover DST). */
export function inScheduledWindow(now: Date): boolean {
  return ptParts(now).hour === 6
}

/**
 * The cron route's optional body. `{ "force": true }` runs today's slot now;
 * `{ "force": true, "slot": "owner_view" }` runs that slot; a Hand-raiser may
 * also pass `"variant": "breakdown" | "story"`. Anything else is a scheduled tick.
 */
export function parseManualBody(body: unknown): { slot: Slot | null; variant: Variant | null } | { error: string } | null {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  if (b.force !== true) return null
  if (b.slot !== undefined && !isSlot(b.slot)) return { error: `slot must be one of ${SLOTS.join(', ')}` }
  if (b.variant !== undefined && b.variant !== 'breakdown' && b.variant !== 'story') return { error: 'variant must be breakdown or story' }
  return { slot: (b.slot as Slot | undefined) ?? null, variant: (b.variant as Variant | undefined) ?? null }
}
