/**
 * Reply desk (LinkedIn replies via SendPilot → Slack): config, spend rule and
 * the PT posting window (pure).
 *
 * `lume_settings.reply_desk_config`:
 *   slack: { team_id, channel_id, channel_name }  the one channel SendPilot posts into
 *   monthly_cap_usd: 10                            Claude spend, checked before every call
 *   followup_days: [2, 5, 9, 14, 21]               days after the Sent that started the schedule
 *   checkin_days: 30                               "not now" with no date named
 *   models: { extract, draft }
 */
import { callUsd, fitsCap, ptParts, round4 } from '@/lib/content/config'

export const REPLY_DESK_CONFIG_KEY = 'reply_desk_config'
export const DEFAULT_MONTHLY_CAP_USD = 10
export const MAX_MONTHLY_CAP_USD = 10
export const DEFAULT_FOLLOWUP_DAYS = [2, 5, 9, 14, 21] as const
export const DEFAULT_CHECKIN_DAYS = 30
export const DEFAULT_EXTRACT_MODEL = 'claude-haiku-5-5'
export const DEFAULT_DRAFT_MODEL = 'claude-opus-5-5'
/** Output ceilings per call (thinking included); live.ts sends them as max_tokens. */
export const EXTRACT_MAX_OUTPUT = 2000
export const DRAFT_MAX_OUTPUT = 4000
/** Input ceilings for the worst-case estimate (raw message capped at RAW_MAX_CHARS ≈ 3k tokens). */
export const EXTRACT_MAX_INPUT = 6000
export const DRAFT_MAX_INPUT = 8000
/** Posting window: weekdays 8 AM to 6 PM Pacific. */
export const WINDOW_START_HOUR = 8
export const WINDOW_END_HOUR = 18

const TEAM = /^[TE][A-Z0-9]{2,30}$/
const CHANNEL = /^[CG][A-Z0-9]{2,30}$/

export interface ReplyDeskConfig {
  slack: { team_id: string | null; channel_id: string | null; channel_name: string | null }
  monthly_cap_usd: number
  followup_days: number[]
  checkin_days: number
  models: { extract: string; draft: string }
  /** The raw value, so saving the channel keeps every other key. */
  raw: Record<string, unknown>
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const model = (v: unknown, d: string) => (typeof v === 'string' && /^claude-[a-z0-9-]{3,60}$/.test(v) ? v : d)

export function parseReplyDeskConfig(value: unknown): ReplyDeskConfig {
  const raw = obj(value)
  const slack = obj(raw.slack)
  const cap = raw.monthly_cap_usd
  const days = Array.isArray(raw.followup_days)
    ? [...new Set(raw.followup_days.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 365))].sort((a, b) => a - b)
    : []
  const checkin = raw.checkin_days
  const name = typeof slack.channel_name === 'string' ? slack.channel_name.trim().replace(/^#/, '').slice(0, 80) : ''
  const models = obj(raw.models)
  return {
    slack: {
      team_id: typeof slack.team_id === 'string' && TEAM.test(slack.team_id) ? slack.team_id : null,
      channel_id: typeof slack.channel_id === 'string' && CHANNEL.test(slack.channel_id) ? slack.channel_id : null,
      channel_name: name || null,
    },
    monthly_cap_usd: typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? Math.min(cap, MAX_MONTHLY_CAP_USD) : DEFAULT_MONTHLY_CAP_USD,
    followup_days: days.length ? days.slice(0, 10) : [...DEFAULT_FOLLOWUP_DAYS],
    checkin_days: typeof checkin === 'number' && Number.isInteger(checkin) && checkin >= 1 && checkin <= 365 ? checkin : DEFAULT_CHECKIN_DAYS,
    models: { extract: model(models.extract, DEFAULT_EXTRACT_MODEL), draft: model(models.draft, DEFAULT_DRAFT_MODEL) },
    raw,
  }
}

// ── spend ──────────────────────────────────────────────────────────────────

export type CallKind = 'extract' | 'draft'

/** The most one call can cost: every input token written to cache, the full output ceiling. */
export function estimateUsd(kind: CallKind, modelId: string): number {
  const [inp, out] = kind === 'extract' ? [EXTRACT_MAX_INPUT, EXTRACT_MAX_OUTPUT] : [DRAFT_MAX_INPUT, DRAFT_MAX_OUTPUT]
  return callUsd(modelId, { input_tokens: 0, cache_creation_input_tokens: inp, output_tokens: out })
}

/** True when one more call at its worst case keeps the month within the cap. */
export function canSpend(monthToDateUsd: number, cfg: Pick<ReplyDeskConfig, 'monthly_cap_usd'>, kind: CallKind, modelId: string): boolean {
  return fitsCap(monthToDateUsd, cfg.monthly_cap_usd, estimateUsd(kind, modelId))
}

export { callUsd, round4 }

// ── the PT window ──────────────────────────────────────────────────────────

/** Inside weekdays 8:00–17:59 Pacific. */
export function inWindow(now: Date): boolean {
  const p = ptParts(now)
  return p.weekday >= 1 && p.weekday <= 5 && p.hour >= WINDOW_START_HOUR && p.hour < WINDOW_END_HOUR
}

/** `at` itself when inside the window, else the next weekday 8:00 AM Pacific (to the minute). */
export function nextWindowStart(at: Date): Date {
  if (inWindow(at)) return at
  // Walk forward in 15-minute steps to the first instant inside the window (at most ~3.5 days).
  let t = Math.ceil(at.getTime() / 900_000) * 900_000
  for (let i = 0; i < 400; i++, t += 900_000) {
    const d = new Date(t)
    if (inWindow(d)) {
      const p = ptParts(d)
      // Snap back to the top of the 8 AM hour when that is where the window opened.
      return p.hour === WINDOW_START_HOUR ? new Date(t - p.minute * 60_000) : d
    }
  }
  return new Date(t)
}

const DAY_MS = 86_400_000

/** When follow-up `step` (0-based) falls due: anchor + followup_days[step], moved into the window. Null past the last step. */
export function followupDue(anchorIso: string, step: number, days: readonly number[]): Date | null {
  const n = days[step]
  const t = Date.parse(anchorIso)
  if (n === undefined || !Number.isFinite(t)) return null
  return nextWindowStart(new Date(t + n * DAY_MS))
}

/** A "not now" check-in: the date they named (9 AM PT that day, or the next window), else anchor + checkin_days. */
export function checkinDue(anchorIso: string, checkBackOn: string | null, checkinDays: number): Date {
  if (checkBackOn && /^\d{4}-\d{2}-\d{2}$/.test(checkBackOn)) {
    const [y, m, d] = checkBackOn.split('-').map(Number)
    // 17:00 UTC is 9 or 10 AM Pacific: inside the window on a weekday.
    const at = new Date(Date.UTC(y, m - 1, d, 17))
    if (Number.isFinite(at.getTime()) && at.getTime() > Date.parse(anchorIso)) return nextWindowStart(at)
  }
  return nextWindowStart(new Date(Date.parse(anchorIso) + checkinDays * DAY_MS))
}
