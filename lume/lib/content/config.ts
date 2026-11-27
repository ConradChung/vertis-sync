/**
 * LinkedIn draft generator: config (`lume_settings.content_config`), the
 * spend rule and the PT calendar helpers (pure).
 *
 * Parsed defensively, like the hiring signal's config: anything that is not
 * exactly `dry_run: false` is a dry run (drafts are stored, nothing goes to
 * Slack), and the monthly cap is clamped to $5.
 */

export const CONTENT_CONFIG_KEY = 'content_config'
export const DEFAULT_CHANNEL = 'content-gen'
export const DEFAULT_MONTHLY_CAP_USD = 5
export const MAX_MONTHLY_CAP_USD = 5
/** What one Claude call is allowed to cost at most, checked against the cap before each call. */
export const CALL_ESTIMATE_USD = 0.25
export const DEFAULT_MODEL = 'claude-opus-5-5'

const TEAM = /^[TE][A-Z0-9]{2,30}$/
const CHANNEL = /^[CG][A-Z0-9]{2,30}$/

export interface ContentConfig {
  dry_run: boolean
  slack: { channel_name: string; team_id: string | null; channel_id: string | null }
  monthly_cap_usd: number
  /** The raw value, so saving the resolved channel keeps every other key. */
  raw: Record<string, unknown>
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})

export function parseContentConfig(value: unknown): ContentConfig {
  const raw = obj(value)
  const slack = obj(raw.slack)
  const name = typeof slack.channel_name === 'string' && slack.channel_name.trim() ? slack.channel_name.trim().replace(/^#/, '') : DEFAULT_CHANNEL
  const cap = raw.monthly_cap_usd
  return {
    dry_run: raw.dry_run !== false,
    slack: {
      channel_name: name,
      team_id: typeof slack.team_id === 'string' && TEAM.test(slack.team_id) ? slack.team_id : null,
      channel_id: typeof slack.channel_id === 'string' && CHANNEL.test(slack.channel_id) ? slack.channel_id : null,
    },
    monthly_cap_usd: typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? Math.min(cap, MAX_MONTHLY_CAP_USD) : DEFAULT_MONTHLY_CAP_USD,
    raw,
  }
}

export function contentModel(env: Record<string, string | undefined> = process.env): string {
  return env.LUME_CONTENT_MODEL?.trim() || DEFAULT_MODEL
}

// ── spend ──────────────────────────────────────────────────────────────────

export const round4 = (n: number) => Math.round(n * 10_000) / 10_000

/** True when one more call (at its estimate) keeps month-to-date spend within the cap. */
export function fitsCap(monthToDateUsd: number, capUsd: number, estimateUsd: number = CALL_ESTIMATE_USD): boolean {
  return round4(monthToDateUsd + estimateUsd) <= round4(capUsd)
}

/** $ per million tokens: [input, output]. Unknown models are priced high so the cap stays safe. */
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-fable-5-2': [8, 40],
}
const FALLBACK_PRICE: [number, number] = [10, 50]

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

export function callUsd(model: string, u: TokenUsage): number {
  const [inp, out] = PRICES[model] ?? FALLBACK_PRICE
  const cents =
    u.input_tokens * inp + (u.cache_creation_input_tokens ?? 0) * inp * 1.25 + (u.cache_read_input_tokens ?? 0) * inp * 0.1 + u.output_tokens * out
  return round4(cents / 1e6)
}

// ── PT calendar ────────────────────────────────────────────────────────────

const TZ = 'America/Los_Angeles'

export interface PtParts {
  date: string // YYYY-MM-DD
  weekday: number // 0 Sunday .. 6 Saturday
  hour: number
  minute: number
}

export function ptParts(now: Date): PtParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: wd, hour: Number(get('hour')), minute: Number(get('minute')) }
}

/** Start of the PT month as an ISO instant (07:00 UTC, the earlier of PST/PDT midnight). */
export function monthStartIso(now: Date): string {
  const { date } = ptParts(now)
  const [y, m] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1, 7)).toISOString()
}
