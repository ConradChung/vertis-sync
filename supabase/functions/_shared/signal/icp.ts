// The ICP gate for LinkedIn signals (commenters and reactors), read from
// lume_settings.signal_config.icp so the owner can change it without a deploy:
//   { "min_units": 500, "owner_operator_only": true, "unknown_units": "hold" }
// - owner_operator_only: a property-management company is skipped at verify
//   (commenters) or before the crawl (reactors), before any crawl spend.
// - min_units: a known door count below it is skipped ('under_min_units').
// - unknown_units: what happens when no count was found after the doors step.
//   'hold' parks the row at stage 'held' (no Slack card; shown in Lume's Signals
//   with "Units unknown" until the owner types a count), 'skip' skips it,
//   'continue' lets it through as before.
// Lume mirrors this parse in lume/lib/signals/icp.ts (the release-by-typed-count path).

export type UnknownUnits = 'hold' | 'skip' | 'continue'

export interface Icp {
  min_units: number
  owner_operator_only: boolean
  unknown_units: UnknownUnits
}

export const DEFAULT_ICP: Icp = { min_units: 500, owner_operator_only: true, unknown_units: 'hold' }

export const SKIP_PM_COMPANY = 'pm_company'
export const SKIP_UNDER_MIN_UNITS = 'under_min_units'
export const SKIP_UNITS_UNKNOWN = 'units_unknown'

type Obj = Record<string, unknown>

/** Defensive parse; anything missing or malformed takes the default. */
export function readIcp(value: unknown): Icp {
  const o = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Obj
  const min = o.min_units
  const u = o.unknown_units
  return {
    min_units: typeof min === 'number' && Number.isFinite(min) && min >= 0 ? Math.floor(min) : DEFAULT_ICP.min_units,
    owner_operator_only: typeof o.owner_operator_only === 'boolean' ? o.owner_operator_only : DEFAULT_ICP.owner_operator_only,
    unknown_units: u === 'hold' || u === 'skip' || u === 'continue' ? u : DEFAULT_ICP.unknown_units,
  }
}

/** What the gate does with a door count (null = unknown). */
export function unitGate(doorCount: number | null | undefined, icp: Icp): 'continue' | 'skip' | 'hold' {
  if (typeof doorCount === 'number' && Number.isFinite(doorCount)) return doorCount >= icp.min_units ? 'continue' : 'skip'
  return icp.unknown_units
}

/** True when the segment is let through ('pm' only when owner_operator_only is off). */
export const segmentAllowed = (segment: string | null | undefined, icp: Icp): boolean =>
  !icp.owner_operator_only || segment === 'owner_operator'
