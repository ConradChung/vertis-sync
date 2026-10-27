import type { GateRow, PendingActionRow } from '@/lib/db/types'
import type { Operator, Vertical } from '@/lib/operators/types'
import { scopeForGate, verticalFor } from '@/lib/operators/route'
import type { AlertLike } from '@/lib/operators/checkin'

/**
 * Overview "Verticals" strip (Phase G6): one card per live vertical. Pure;
 * `/api/overview/verticals` feeds it four parallel reads (verticals, keys,
 * open gates, unacked alerts, the last week's decided actions).
 */

/** A bot that has not checked in for this long is shown red. */
export const STALE_CHECKIN_MS = 30 * 60 * 1000

export interface VerticalCard {
  id: string
  name: string
  is_default: boolean
  bots: number
  last_check_in: string | null
  stale: boolean
  needs_confirmation: number
  unacked_alerts: number
  last_bot_action: { id: string; kind: string; summary: string; status: string; decided_at: string | null } | null
}

export function verticalCards(args: {
  verticals: readonly Vertical[]
  operators: readonly Operator[]
  gates: readonly GateRow[]
  alerts: readonly AlertLike[]
  decided: readonly PendingActionRow[]
  now: Date
}): VerticalCard[] {
  const live = args.verticals.filter((v) => !v.archived_at)
  const gateCount = new Map<string, number>()
  for (const g of args.gates) {
    const v = verticalFor(scopeForGate(g), live)
    if (v) gateCount.set(v.id, (gateCount.get(v.id) ?? 0) + 1)
  }
  const alertCount = new Map<string, number>()
  for (const a of args.alerts) {
    const v = verticalFor(a, live)
    if (v) alertCount.set(v.id, (alertCount.get(v.id) ?? 0) + 1)
  }
  const botVertical = new Map(args.operators.map((o) => [o.id, o.vertical_id]))
  return live.map((v) => {
    const bots = args.operators.filter((o) => !o.revoked_at && !o.is_master && o.vertical_id === v.id)
    const last = bots.map((o) => o.last_seen_at).filter((s): s is string => !!s).sort().at(-1) ?? null
    const action = args.decided
      .filter((a) => a.decided_via === 'operator' && a.decided_by_operator && botVertical.get(a.decided_by_operator) === v.id)
      .sort((a, b) => ((a.decided_at ?? '') < (b.decided_at ?? '') ? 1 : -1))[0]
    return {
      id: v.id,
      name: v.name,
      is_default: v.is_default,
      bots: bots.length,
      last_check_in: last,
      stale: !last || args.now.getTime() - new Date(last).getTime() > STALE_CHECKIN_MS,
      needs_confirmation: gateCount.get(v.id) ?? 0,
      unacked_alerts: alertCount.get(v.id) ?? 0,
      last_bot_action: action
        ? {
            id: action.id,
            kind: action.kind,
            summary: typeof action.payload?.summary === 'string' ? action.payload.summary : action.kind,
            status: action.status,
            decided_at: action.decided_at,
          }
        : null,
    }
  })
}

