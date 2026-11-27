import { checkKey } from '@/lib/hiring/engine'
import { fitsCap, type HiringConfig, type Lane } from '@/lib/hiring/config'
import type { GroundedDoors } from '@/lib/hiring/checkPrompt'
import { normCompany } from '@/lib/hiring/normalize'

/**
 * One-off backfill: look the unit count up once per company for hiring rows
 * that are shown (finished, not skipped), have a company and have no count.
 * Pure: the lookup and the store are ports (scripts/hiring-doors-backfill.ts
 * wires the live ones). Every lookup goes through the lane's own spend ledger
 * and monthly cap (fitsCap), and the run stops once its own spend would pass
 * `budgetUsd` ($1). Information only: no row's qualification, draft or
 * status changes.
 */

/** Perplexity sonar call + Haiku parse, a ceiling per company. */
export const DOOR_LOOKUP_USD = 0.008
export const BACKFILL_BUDGET_USD = 1

export interface MissingRow {
  id: number
  signal: Lane
  company_name: string | null
  company_domain: string | null
  location: string | null
}

export interface BackfillStore {
  getConfig(): Promise<HiringConfig>
  monthSpend(fromIso: string): Promise<number>
  addSpend(e: { lane: Lane; kind: 'check'; usd: number; status: 'settled'; row_id: number }): Promise<void>
  listMissing(): Promise<MissingRow[]>
  /** Set the count on these rows (only where they still have none) and on the company's cached check. */
  saveDoors(rowIds: number[], checkKey: string, d: GroundedDoors & { door_count: number }): Promise<void>
}

export type DoorLookup = (company: string, location: string) => Promise<{ doors: GroundedDoors; usd: number }>

export interface BackfillResult {
  companies: number
  looked_up: number
  found: number
  rows_filled: number
  spent_usd: number
  stopped: 'done' | 'budget' | 'monthly_cap' | 'error'
  error?: string
}

export async function runDoorBackfill(deps: { store: BackfillStore; lookup: DoorLookup; now?: Date; budgetUsd?: number; maxLookups?: number }): Promise<BackfillResult> {
  const { store, lookup } = deps
  const now = deps.now ?? new Date()
  const budget = deps.budgetUsd ?? BACKFILL_BUDGET_USD
  const cfg = await store.getConfig()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  let mtd = await store.monthSpend(monthStart)

  // One lookup per company: rows grouped by the same key the check cache uses.
  const groups = new Map<string, MissingRow[]>()
  for (const r of await store.listMissing()) {
    const key = checkKey(r.company_domain, normCompany(r.company_name))
    if (!key || !r.company_name?.trim()) continue
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const out: BackfillResult = { companies: groups.size, looked_up: 0, found: 0, rows_filled: 0, spent_usd: 0, stopped: 'done' }
  for (const [key, rows] of groups) {
    if (deps.maxLookups !== undefined && out.looked_up >= deps.maxLookups) break
    if (Math.round((out.spent_usd + DOOR_LOOKUP_USD) * 1e4) > Math.round(budget * 1e4)) {
      out.stopped = 'budget'
      break
    }
    if (!fitsCap(mtd, DOOR_LOOKUP_USD, cfg.monthly_cap_usd)) {
      out.stopped = 'monthly_cap'
      break
    }
    const first = rows[0]
    try {
      const { doors, usd } = await lookup(first.company_name!, first.location ?? first.company_domain ?? '')
      out.looked_up++
      out.spent_usd = Math.round((out.spent_usd + usd) * 1e6) / 1e6
      mtd += usd
      await store.addSpend({ lane: first.signal, kind: 'check', usd, status: 'settled', row_id: first.id })
      if (doors.door_count && doors.door_count > 0) {
        await store.saveDoors(
          rows.map((r) => r.id),
          key,
          doors as GroundedDoors & { door_count: number }
        )
        out.found++
        out.rows_filled += rows.length
      }
    } catch (e) {
      out.stopped = 'error'
      out.error = e instanceof Error ? e.message : String(e)
      break
    }
  }
  return out
}
