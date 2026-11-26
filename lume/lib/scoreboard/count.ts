import type { Week } from '@/lib/scoreboard/week'

/** The weekly scoreboard's three counts (pure). */
export interface ScoreCounts {
  /** Deals that entered Conversation this week. */
  conversations: number
  /** Deals whose pilot start date falls in this week. */
  pilots_started: number
  /** Deals that entered Paid this week. */
  pilots_paid: number
}

/** A `stage_changed` activity, as the scoreboard reads it. */
export interface StageChange {
  deal_id: string
  to: string | null
  occurred_at: string
}

export interface PilotStart {
  id: string
  pilot_start_date: string | null
}

/**
 * Counts for one week. A deal counts once per column however often it was
 * moved in and out; changes outside [start, end) and pilot dates outside the
 * week's dates are ignored, so callers may pass a wider window.
 */
export function countScoreboard(changes: readonly StageChange[], starts: readonly PilotStart[], week: Week): ScoreCounts {
  const from = Date.parse(week.start_iso)
  const to = Date.parse(week.end_iso)
  const entered = (stage: string) => {
    const ids = new Set<string>()
    for (const c of changes) {
      const t = Date.parse(c.occurred_at)
      if (c.to === stage && Number.isFinite(t) && t >= from && t < to) ids.add(c.deal_id)
    }
    return ids.size
  }
  const started = new Set<string>()
  for (const s of starts) if (s.pilot_start_date && s.pilot_start_date >= week.start && s.pilot_start_date < week.end) started.add(s.id)
  return { conversations: entered('Conversation'), pilots_started: started.size, pilots_paid: entered('Paid') }
}

export interface Scoreboard {
  week: Pick<Week, 'start' | 'end' | 'label'>
  counts: ScoreCounts
  top_objection: string | null
}
