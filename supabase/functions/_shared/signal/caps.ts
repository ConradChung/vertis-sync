// GTM-14 comments lane: spend caps. Pure.
//
// Caps (lume_settings.signal_config.caps), all checked before a spend:
//   comments_apify   per Apify billing cycle  <= caps.comments_apify_usd   ($10)
//   comments_filter  per Apify billing cycle  <= caps.comments_filter_usd  ($5)
//   both lanes       per America/Los_Angeles calendar day <= caps.comments_daily_usd ($1)
//   account guard    Apify account usage this cycle + open reservations + this
//                    reservation <= lume_settings.apify_monthly_cap_usd (Apify lane only)
// A spend that would cross a cap is refused and stops the lane until that
// window has passed (stopped_reason starts with the window key).

export const PT = 'America/Los_Angeles'

export type Lane = 'comments_apify' | 'comments_filter'
export type CapName = 'daily' | 'comments_apify' | 'comments_filter' | 'account'

export interface Caps {
  comments_apify_usd: number
  comments_filter_usd: number
  comments_daily_usd: number
  warn_at: number
}

export const DEFAULT_CAPS: Caps = { comments_apify_usd: 10, comments_filter_usd: 5, comments_daily_usd: 1, warn_at: 0.8 }

/** Caps from signal_config, each falling back to the default when missing or invalid. */
export function readCaps(raw: unknown): Caps {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pos = (k: keyof Caps) => {
    const n = Number(c[k])
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAPS[k]
  }
  const warn = Number(c.warn_at)
  return {
    comments_apify_usd: pos('comments_apify_usd'),
    comments_filter_usd: pos('comments_filter_usd'),
    comments_daily_usd: pos('comments_daily_usd'),
    warn_at: Number.isFinite(warn) && warn > 0 && warn < 1 ? warn : DEFAULT_CAPS.warn_at,
  }
}

export interface Cycle { startAt: string; endAt: string }

/** Apify GET /v2/users/me/usage/monthly → the billing cycle and the account's usage in it (USD). */
export function parseUsageCycle(body: unknown): { cycle: Cycle; usageUsd: number } | null {
  const data = body && typeof body === 'object' ? (body as Record<string, unknown>).data : null
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const uc = (d.usageCycle && typeof d.usageCycle === 'object' ? d.usageCycle : {}) as Record<string, unknown>
  const startAt = typeof uc.startAt === 'string' && Number.isFinite(Date.parse(uc.startAt)) ? new Date(uc.startAt).toISOString() : null
  const endAt = typeof uc.endAt === 'string' && Number.isFinite(Date.parse(uc.endAt)) ? new Date(uc.endAt).toISOString() : null
  let usage: number | null = null
  for (const k of ['totalUsageCreditsUsdAfterVolumeDiscount', 'totalUsageCreditsUsdBeforeVolumeDiscount']) {
    const v = d[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      usage = v
      break
    }
  }
  if (!startAt || !endAt || usage === null) return null
  return { cycle: { startAt, endAt }, usageUsd: usage }
}

// ---------------------------------------------------------------------------
// Pacific time

function tzOffsetMs(at: Date, tz = PT): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at).map((x) => [x.type, x.value]),
  )
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** YYYY-MM-DD of an instant in America/Los_Angeles. */
export function ptDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** The instant the PT calendar day containing `at` began. */
export function ptDayStart(at: Date): Date {
  const [y, m, d] = ptDate(at).split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  let start = guess - tzOffsetMs(new Date(guess))
  start = guess - tzOffsetMs(new Date(start)) // DST-correct
  return new Date(start)
}

/** The instant the next PT calendar day begins. */
export function ptNextDayStart(at: Date): Date {
  return ptDayStart(new Date(ptDayStart(at).getTime() + 30 * 3_600_000))
}

// ---------------------------------------------------------------------------
// Checks

export interface Spent {
  /** comments_apify this cycle (reserved + settled). */
  apifyCycle: number
  /** comments_filter this cycle. */
  filterCycle: number
  /** both comments lanes since the PT day began. */
  daily: number
}

export interface Account { usageUsd: number; openReservedUsd: number; capUsd: number }

export interface CapInput {
  lane: Lane
  usd: number
  caps: Caps
  cycle: Cycle
  now: Date
  spent: Spent
  /** Required for the Apify lane. */
  account?: Account
}

export interface CapStop {
  ok: false
  cap: CapName
  /** e.g. daily:2026-11-23, comments_apify:2026-11-04 (cycle start date). */
  window: string
  noticeKey: string
  limit: number
  spent: number
  usd: number
  resetsAt: string
  text: string
}
export type CapCheck = { ok: true } | CapStop

const money = (n: number) => `$${n.toFixed(2)}`
const EPS = 1e-9

function fmtReset(iso: string): string {
  const d = new Date(iso)
  const s = new Intl.DateTimeFormat('en-US', { timeZone: PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)
  return `${s} PT`
}

const cycleKey = (c: Cycle) => c.startAt.slice(0, 10)

function stop(cap: CapName, window: string, limit: number, spent: number, usd: number, resetsAt: string, label: string): CapStop {
  return {
    ok: false, cap, window, noticeKey: `stop:${window}`, limit, spent, usd, resetsAt,
    text: `Frank comment alerts paused: the ${label} cap (${money(limit)}) would be crossed ` +
      `(${money(spent)} spent, next spend ${money(usd)}). Nothing more is spent until it resets at ${fmtReset(resetsAt)}.`,
  }
}

/** Would spending `usd` on `lane` cross a cap? Order: daily, the lane's cycle cap, the account guard. */
export function checkCap(i: CapInput): CapCheck {
  const usd = Math.max(0, i.usd)
  if (i.spent.daily + usd > i.caps.comments_daily_usd + EPS) {
    return stop('daily', `daily:${ptDate(i.now)}`, i.caps.comments_daily_usd, i.spent.daily, usd, ptNextDayStart(i.now).toISOString(), 'daily (both comments lanes, PT day)')
  }
  if (i.lane === 'comments_apify') {
    if (i.spent.apifyCycle + usd > i.caps.comments_apify_usd + EPS) {
      return stop('comments_apify', `comments_apify:${cycleKey(i.cycle)}`, i.caps.comments_apify_usd, i.spent.apifyCycle, usd, i.cycle.endAt, 'comments Apify per billing cycle')
    }
    const a = i.account
    if (!a) return stop('account', `account:${cycleKey(i.cycle)}`, 0, 0, usd, i.cycle.endAt, 'Apify account (usage unknown)')
    const used = a.usageUsd + a.openReservedUsd
    if (used + usd > a.capUsd + EPS) {
      return stop('account', `account:${cycleKey(i.cycle)}`, a.capUsd, used, usd, i.cycle.endAt, 'Apify account monthly')
    }
  } else if (i.spent.filterCycle + usd > i.caps.comments_filter_usd + EPS) {
    return stop('comments_filter', `comments_filter:${cycleKey(i.cycle)}`, i.caps.comments_filter_usd, i.spent.filterCycle, usd, i.cycle.endAt, 'comments filter per billing cycle')
  }
  return { ok: true }
}

/** signal_state.stopped_reason: the window key, then the human text. */
export const stoppedReason = (s: CapStop) => `${s.window} ${s.text}`

/**
 * Is a recorded stop still in force? A daily stop lasts until the PT date
 * changes; a cycle / account stop until the Apify cycle start changes. With
 * no cycle known a cycle stop stays; an unreadable reason holds for 24 h.
 */
export function stopActive(state: { stopped_at: string | null; stopped_reason: string | null }, now: Date, cycle: Cycle | null): boolean {
  if (!state.stopped_at) return false
  const window = (state.stopped_reason ?? '').split(' ')[0]
  const m = /^(daily|comments_apify|comments_filter|account):(\d{4}-\d{2}-\d{2})$/.exec(window)
  if (!m) return now.getTime() - Date.parse(state.stopped_at) < 24 * 3_600_000
  if (m[1] === 'daily') return ptDate(now) === m[2]
  if (!cycle) return true
  return cycleKey(cycle) === m[2] && now.getTime() < Date.parse(cycle.endAt)
}

/** 80% warnings due after a settled spend: one notice per lane per cycle (the insert is on-conflict-do-nothing). */
export function warnings(caps: Caps, cycle: Cycle, spent: Pick<Spent, 'apifyCycle' | 'filterCycle'>): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = []
  const lanes: [Lane, number, number, string][] = [
    ['comments_apify', spent.apifyCycle, caps.comments_apify_usd, 'comments Apify'],
    ['comments_filter', spent.filterCycle, caps.comments_filter_usd, 'comments filter'],
  ]
  for (const [lane, s, cap, label] of lanes) {
    if (s + EPS >= caps.warn_at * cap) {
      out.push({
        key: `warn80:${lane}:${cycleKey(cycle)}`,
        text: `Frank comment alerts: ${money(s)} of the ${money(cap)} ${label} cap used this Apify cycle ` +
          `(${Math.round(caps.warn_at * 100)}% reached). It resets at ${fmtReset(cycle.endAt)}.`,
      })
    }
  }
  return out
}
