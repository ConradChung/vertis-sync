/**
 * Pure helpers for the telegram-inbox entrypoint. Mirrors
 * supabase/functions/_shared/lume/action.ts (LUME_ALLOWED_ACTIONS,
 * parseLumeAction, the lfo_count bounds) so a bad string is refused here
 * before it costs a network round trip. Keep the two lists in step.
 *
 * Barrier toggles, names mode and campaign pick (bar_loc, bar_co, push_strict,
 * push_std, pick_campaign) are Lume-local PATCHes and deliberately absent.
 */

export const LUME_ALLOWED_ACTIONS = [
  // CSV ingest approval
  'approve', 'approve_enrich', 'deny',
  // finder prompt + watchdog resume
  'finder_go', 'finder_skip', 'wd_resume',
  // job search gates
  'jobs_pull', 'jobs_skip', 'jobs_write', 'jobs_discard', 'jobs_resume', 'jobs_abort', 'jobs_order_now',
  // Apollo -> Leadsfriday order
  'lfo_count', 'lfo_cancel', 'lfo_abort',
  // Instantly push (final step only) and launch
  'push_go', 'push_cancel', 'camp_launch',
  // pending_actions (high-risk approvals)
  'lume_ok', 'lume_no',
] as const

export type LumeAction = (typeof LUME_ALLOWED_ACTIONS)[number]

/** Actions whose effect `lume_gates` cannot observe; the entrypoint answers `claimed: null`. */
export const GATELESS_ACTIONS: ReadonlySet<LumeAction> = new Set<LumeAction>([
  'camp_launch', 'jobs_abort', 'lfo_abort', 'push_cancel',
])

export const LFO_MIN_COUNT = 500
export const LFO_MAX_COUNT = 50000

const ALLOWED: ReadonlySet<string> = new Set(LUME_ALLOWED_ACTIONS)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isLumeAction(action: string): action is LumeAction {
  return ALLOWED.has(action)
}

function isValidCount(extra: string): boolean {
  if (!/^\d+$/.test(extra)) return false
  const n = Number(extra)
  return Number.isSafeInteger(n) && n >= LFO_MIN_COUNT && n <= LFO_MAX_COUNT
}

/**
 * `action:targetId[:extra]` exactly as a Telegram button would carry it.
 * Throws on anything the entrypoint would reject, so callers fail before the
 * network. `extra` is required for lfo_count (the contact count) and optional
 * otherwise.
 */
export function buildCallbackData(action: string, targetId: string, extra?: string | number): string {
  if (!isLumeAction(action)) throw new Error(`not a Lume action: ${action}`)
  if (!UUID_RE.test(targetId)) throw new Error('targetId must be a uuid')
  const ex = extra === undefined ? undefined : String(extra)
  if (ex !== undefined && (ex === '' || ex.includes(':'))) throw new Error('extra must be non-empty and contain no ":"')
  if (action === 'lfo_count') {
    if (ex === undefined || !isValidCount(ex)) {
      throw new Error(`lfo_count needs an integer count between ${LFO_MIN_COUNT} and ${LFO_MAX_COUNT}`)
    }
  }
  return ex === undefined ? `${action}:${targetId}` : `${action}:${targetId}:${ex}`
}

export interface ParsedCallbackData {
  action: LumeAction
  targetId: string
  extra: string | undefined
}

/** Same rules as telegram-inbox's `parseLumeAction`; `null` when it would refuse. */
export function parseCallbackData(data: string): ParsedCallbackData | null {
  const parts = data.split(':')
  if (parts.length > 3) return null
  const [action, targetId, extra] = parts
  if (parts.length === 3 && extra === '') return null
  if (!action || !targetId || !UUID_RE.test(targetId)) return null
  if (!isLumeAction(action)) return null
  if (action === 'lfo_count' && (extra === undefined || !isValidCount(extra))) return null
  return { action, targetId, extra }
}
