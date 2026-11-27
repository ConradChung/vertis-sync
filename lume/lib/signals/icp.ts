/**
 * The ICP gate's settings, `lume_settings.signal_config.icp` (pure). Mirrors
 * supabase/functions/_shared/signal/icp.ts, which the filter reads on every
 * tick: { min_units: 500, owner_operator_only: true, unknown_units: 'hold' }.
 */

export type UnknownUnits = 'hold' | 'skip' | 'continue'

export interface Icp {
  min_units: number
  owner_operator_only: boolean
  unknown_units: UnknownUnits
}

export const DEFAULT_ICP: Icp = { min_units: 500, owner_operator_only: true, unknown_units: 'hold' }
export const SKIP_UNDER_MIN_UNITS = 'under_min_units'
/** Upper bound on a typed unit count (a typo guard, not a business rule). */
export const MAX_TYPED_UNITS = 1_000_000

type Obj = Record<string, unknown>

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

/** A typed count releases a held person: at or above the minimum → on to contacts (then the card); below → skipped. */
export function releaseOf(units: number, icp: Icp): 'continue' | 'skip' {
  return units >= icp.min_units ? 'continue' : 'skip'
}
