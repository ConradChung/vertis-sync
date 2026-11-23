import type { EnvName } from '@/lib/health/envExample'

/**
 * Settings → Config health: shapes and pure helpers. Nothing here ever holds
 * a secret value: presence is a boolean per name, and every live-check
 * detail goes through `scrubDetail` before it is returned or stored.
 */

export type Env = (name: string) => string | undefined
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FetchLike = (url: string, init?: any) => Promise<Response>

export interface PresenceRow {
  name: string
  required: boolean
  present: boolean
}

export const CHECK_IDS = ['apify', 'telegram', 'slack', 'worker'] as const
export type CheckId = (typeof CHECK_IDS)[number]

export interface CheckResult {
  ok: boolean
  detail: string
  ms: number
}

export interface HealthRun {
  checked_at: string
  results: Record<CheckId, CheckResult>
}

export type EdgePresence = { ok: true; names: PresenceRow[] } | { ok: false; error: string; names: PresenceRow[] }

/** `lume_settings.config_health`. Lume-owned; written only by Run checks (merge). */
export const CONFIG_HEALTH_KEY = 'config_health'
export const DEFAULT_SLACK_TEST_CHANNEL = 'lume-health'

export interface ConfigHealthSetting {
  slack_test_channel: string | null
  /** Which Slack install to use when several are live. */
  slack_team_id: string | null
  last: HealthRun | null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max = 100): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** Presence of each name, booleans only (empty / whitespace = missing). */
export function presence(names: readonly EnvName[], env: Env): PresenceRow[] {
  return names.map((n) => ({ name: n.name, required: n.required, present: (env(n.name) ?? '').trim().length > 0 }))
}

export const DETAIL_MAX = 300

/**
 * Replace every given secret value (and any `bot<token>` Telegram URL) with
 * `<redacted>`, then clip. Values shorter than 4 chars are skipped (a chat id
 * like "42" would mangle numbers in an ordinary message).
 */
export function scrubDetail(detail: string, secrets: readonly string[]): string {
  let out = String(detail ?? '')
  for (const s of [...secrets].filter((v) => v && v.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(s).join('<redacted>')
  out = out.replace(/https?:\/\/api\.telegram\.org\/\S*/g, '<telegram api>')
  return out.length > DETAIL_MAX ? `${out.slice(0, DETAIL_MAX - 1)}…` : out
}

/** Every non-empty env value among `names`, for scrubbing. */
export function secretValues(names: readonly EnvName[], env: Env): string[] {
  return names.map((n) => (env(n.name) ?? '').trim()).filter((v) => v.length > 0)
}

function parseResult(v: unknown): CheckResult | null {
  if (!isObj(v) || typeof v.ok !== 'boolean') return null
  return { ok: v.ok, detail: typeof v.detail === 'string' ? v.detail.slice(0, DETAIL_MAX) : '', ms: Number.isFinite(v.ms) ? Number(v.ms) : 0 }
}

export function parseConfigHealth(raw: unknown): ConfigHealthSetting {
  const v = isObj(raw) ? raw : {}
  let last: HealthRun | null = null
  if (typeof v.last_checked_at === 'string' && isObj(v.results)) {
    const results = {} as Record<CheckId, CheckResult>
    let any = false
    for (const id of CHECK_IDS) {
      const r = parseResult((v.results as Record<string, unknown>)[id])
      results[id] = r ?? { ok: false, detail: 'not run', ms: 0 }
      any = any || !!r
    }
    if (any) last = { checked_at: v.last_checked_at, results }
  }
  return { slack_test_channel: str(v.slack_test_channel, 80), slack_team_id: str(v.slack_team_id, 40), last }
}

/** The new setting value: the previous one with this run merged in (slack_test_channel and other keys kept). */
export function mergeConfigHealth(prev: unknown, run: HealthRun): Record<string, unknown> {
  return { ...(isObj(prev) ? prev : {}), last_checked_at: run.checked_at, results: run.results }
}
