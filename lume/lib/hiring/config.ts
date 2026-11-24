/**
 * GTM-19 Hiring Ops Signal: config (`lume_settings.hiring_signal_config`)
 * and the spend / schedule rules (pure).
 *
 * Parsed defensively: anything that is not exactly `dry_run: false` is a dry
 * run, and a lane is on only when its flag is exactly `true`. A malformed or
 * missing value is therefore a dry run with every lane off. Caps fall back to
 * the launch values and are clamped (never above $40/month or $5/run).
 */

export const HIRING_CONFIG_KEY = 'hiring_signal_config'

export const LANES = ['hiring', 'new_manager', 'expansion'] as const
export type Lane = (typeof LANES)[number]
export const isLane = (v: unknown): v is Lane => typeof v === 'string' && (LANES as readonly string[]).includes(v)

export const DEFAULT_MONTHLY_CAP_USD = 40
export const MAX_MONTHLY_CAP_USD = 40
export const DEFAULT_RUN_CAP_USD: Record<Lane, number> = { hiring: 2, new_manager: 3, expansion: 1 }
export const MAX_RUN_CAP_USD = 5
export const REGIONS = ['United States', 'Canada'] as const

/** Hours between scheduled runs of a lane (hiring + expansion daily, new_manager weekly). */
export const LANE_EVERY_HOURS: Record<Lane, number> = { hiring: 24, new_manager: 24 * 7, expansion: 24 }

export interface HiringConfig {
  dry_run: boolean
  lanes: Record<Lane, boolean>
  monthly_cap_usd: number
  run_cap_usd: Record<Lane, number>
  regions: string[]
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const usd = (v: unknown, d: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : d)

export function parseHiringConfig(value: unknown): HiringConfig {
  const raw = obj(value)
  const lanes = obj(raw.lanes)
  const caps = obj(raw.run_cap_usd)
  const regions = Array.isArray(raw.regions)
    ? raw.regions.filter((r): r is string => typeof r === 'string' && (REGIONS as readonly string[]).includes(r))
    : [...REGIONS]
  return {
    dry_run: raw.dry_run !== false,
    lanes: { hiring: lanes.hiring === true, new_manager: lanes.new_manager === true, expansion: lanes.expansion === true },
    monthly_cap_usd: usd(raw.monthly_cap_usd, DEFAULT_MONTHLY_CAP_USD, MAX_MONTHLY_CAP_USD),
    run_cap_usd: {
      hiring: usd(caps.hiring, DEFAULT_RUN_CAP_USD.hiring, MAX_RUN_CAP_USD),
      new_manager: usd(caps.new_manager, DEFAULT_RUN_CAP_USD.new_manager, MAX_RUN_CAP_USD),
      expansion: usd(caps.expansion, DEFAULT_RUN_CAP_USD.expansion, MAX_RUN_CAP_USD),
    },
    regions: regions.length ? regions : [...REGIONS],
  }
}

// ── spend ──────────────────────────────────────────────────────────────────

const round4 = (n: number) => Math.round(n * 10_000) / 10_000

/** True when `add` more dollars keeps month-to-date spend within the cap. */
export function fitsCap(monthToDateUsd: number, addUsd: number, monthlyCapUsd: number): boolean {
  return round4(monthToDateUsd + addUsd) <= round4(monthlyCapUsd)
}

/**
 * Month-to-date spend from the ledger rows: settled + reserved (a reservation
 * is the run's maxTotalChargeUsd until the run is read), released rows don't count.
 */
export function monthToDate(rows: { usd: number | string; status: string }[]): number {
  return round4(rows.reduce((s, r) => (r.status === 'released' ? s : s + Number(r.usd || 0)), 0))
}

/** Is a lane due: never ran, or its last scheduled start is at least its interval ago (10 min slack for tick jitter). */
export function isDue(lane: Lane, lastStartedAt: string | null, now: Date): boolean {
  if (!lastStartedAt) return true
  const t = Date.parse(lastStartedAt)
  if (!Number.isFinite(t)) return true
  return now.getTime() - t >= LANE_EVERY_HOURS[lane] * 3_600_000 - 10 * 60_000
}

/** Per-tick unit prices (ceilings) counted toward the cap before the call. */
export const CHECK_USD = 0.008 // Perplexity sonar $0.006 + Haiku parse ceiling (~$0.0012 with the phone/website fields)
export const DRAFT_USD = 0.002 // Haiku draft ceiling: ~3k chars in, 600 tokens out
export const EXTRACT_USD = 0.001 // Haiku news extraction ceiling per article

/**
 * The manual override body of /api/cron/hiring-signal:
 * `{ lane, run_cap_usd?, max_items?, force: true }`. null = a scheduled tick
 * (no body, or no `force: true`); `{ error }` = a malformed override.
 */
export function parseManualBody(body: unknown): { lane: Lane; run_cap_usd?: number; max_items?: number } | { error: string } | null {
  const b = obj(body)
  if (b.force !== true) return null
  if (!isLane(b.lane)) return { error: `lane must be one of ${LANES.join(', ')}` }
  const out: { lane: Lane; run_cap_usd?: number; max_items?: number } = { lane: b.lane }
  if (b.run_cap_usd !== undefined) {
    if (typeof b.run_cap_usd !== 'number' || !(b.run_cap_usd > 0) || b.run_cap_usd > MAX_RUN_CAP_USD) return { error: `run_cap_usd must be in (0, ${MAX_RUN_CAP_USD}]` }
    out.run_cap_usd = b.run_cap_usd
  }
  if (b.max_items !== undefined) {
    if (typeof b.max_items !== 'number' || !Number.isInteger(b.max_items) || b.max_items < 1 || b.max_items > 500) return { error: 'max_items must be an integer in [1, 500]' }
    out.max_items = b.max_items
  }
  return out
}
