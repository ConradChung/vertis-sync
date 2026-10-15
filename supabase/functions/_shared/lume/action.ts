// Lume -> telegram-inbox entrypoint: pure helpers.
//
// Lume never copies the conditional-PATCH claims out of telegram-inbox. It
// POSTs the exact callback_data string a Telegram button would carry, and the
// function runs the same handler with a synthetic callback. These helpers
// validate that string before it reaches handleCallback and compare the
// shared secret without leaking its length or prefix through timing.

export const LUME_MIN_COUNT = 500
// Leadsfriday's practical ceiling for one export; above this a typo (an extra
// zero) would place a very expensive order with no second prompt.
export const LUME_MAX_COUNT = 50000

// Only what Lume actually sends. The barrier / preview screens (bar_loc,
// bar_co, push_strict, push_std, camp_pick, camp_tpl, camp_nolo) stay local to
// Lume, which PATCHes those columns itself like /api/instantly/push does;
// lfo_custom and push_next are Telegram-only navigation. Anything not listed
// here is rejected before it can reach the dispatcher.
export const LUME_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
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
])

export interface LumeAction { action: string; targetId: string; extra?: string }

export function parseLumeAction(data: string): LumeAction | null {
  const parts = data.split(':')
  // At most action:target:extra. A 4th segment is not a button we ever emit.
  if (parts.length > 3) return null
  const [action, targetId, extra] = parts
  if (!action || !targetId || !/^[0-9a-f-]{36}$/i.test(targetId)) return null
  if (!LUME_ALLOWED_ACTIONS.has(action)) return null
  if (action === 'lfo_count') {
    // Digits only: rejects ' 750 ', '1e9', '0x300', '-500', 'Infinity' before
    // Number() can reinterpret them. Then a safe integer inside the bounds.
    if (!extra || !/^\d+$/.test(extra)) return null
    const n = Number(extra)
    if (!Number.isSafeInteger(n) || n < LUME_MIN_COUNT || n > LUME_MAX_COUNT) return null
  }
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
