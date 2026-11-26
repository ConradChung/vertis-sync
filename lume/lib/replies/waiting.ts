/**
 * How long something has waited for the owner (pure): the timer on every
 * /replies row and the Today queue. Flagged once it passes 60 minutes.
 */

export const FLAG_AFTER_MIN = 60

export interface Waiting {
  /** Whole minutes waited (0 for a future or unreadable start). */
  minutes: number
  /** "just now", "12 min", "1 h 05 min", "2 d 3 h". */
  label: string
  /** Past 60 minutes. Exactly 60 is not yet over. */
  overdue: boolean
}

export function waitingOf(sinceIso: string | null | undefined, now: Date | number = Date.now()): Waiting {
  const t = sinceIso ? Date.parse(sinceIso) : NaN
  const ms = (typeof now === 'number' ? now : now.getTime()) - t
  const minutes = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60_000) : 0
  return { minutes, label: waitLabel(minutes), overdue: minutes > FLAG_AFTER_MIN }
}

export function waitLabel(minutes: number): string {
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h < 24) return `${h} h ${String(m).padStart(2, '0')} min`
  const d = Math.floor(h / 24)
  return `${d} d ${h % 24} h`
}
