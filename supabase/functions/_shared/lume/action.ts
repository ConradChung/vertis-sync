// Lume -> telegram-inbox entrypoint: pure helpers.
//
// Lume never copies the conditional-PATCH claims out of telegram-inbox. It
// POSTs the exact callback_data string a Telegram button would carry, and the
// function runs the same handler with a synthetic callback. These helpers
// validate that string before it reaches handleCallback and compare the
// shared secret without leaking its length or prefix through timing.

export const LUME_MIN_COUNT = 500

// Every callback prefix handleCallback dispatches. Anything else is rejected
// before it can reach the dispatcher's "Unrecognized action" fallback.
export const LUME_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  // finder prompt + watchdog resume
  'finder_go', 'finder_skip', 'wd_resume',
  // JOBS_ACTIONS
  'jobs_pull', 'jobs_skip', 'jobs_write', 'jobs_discard', 'jobs_resume', 'jobs_abort', 'jobs_order_now',
  // LFO_ACTIONS
  'lfo_count', 'lfo_custom', 'lfo_cancel', 'lfo_abort',
  // PUSH_ACTIONS
  'camp_pick', 'camp_tpl', 'camp_launch', 'camp_nolo',
  'bar_loc', 'bar_co', 'push_next', 'push_go', 'push_strict', 'push_std', 'push_cancel',
  // CSV ingest approval
  'approve', 'approve_enrich', 'deny',
  // pending_actions (high-risk approvals)
  'lume_ok', 'lume_no',
])

export interface LumeAction { action: string; targetId: string; extra?: string }

export function parseLumeAction(data: string): LumeAction | null {
  const [action, targetId, extra] = data.split(':')
  if (!action || !targetId || !/^[0-9a-f-]{36}$/i.test(targetId)) return null
  if (!LUME_ALLOWED_ACTIONS.has(action)) return null
  // `!(n >= min)` rather than `n < min`: Number('abc') is NaN, and NaN fails
  // every comparison, so a plain `<` would let a non-numeric count through.
  if (action === 'lfo_count' && (!extra || !(Number(extra) >= LUME_MIN_COUNT))) return null
  return { action, targetId, extra }
}

// Constant-time secret check. Both sides are hashed first so the comparison
// runs over equal-length buffers regardless of what the caller sent; the loop
// then touches every byte. An empty expected secret never matches: an unset
// LUME_ACTION_SECRET must mean "entrypoint closed", not "entrypoint open".
export async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  if (!expected || !provided) return false
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(provided)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ])
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}
