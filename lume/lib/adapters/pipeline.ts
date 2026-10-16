import 'server-only'
import { parseCallbackData } from '@/lib/adapters/pipeline.actions'

/**
 * The one way Lume decides a gate: POST the exact `callback_data` a Telegram
 * button would carry to the telegram-inbox entrypoint, which runs the same
 * handler (and the same conditional-PATCH claim) a tap would. Lume never
 * copies those claims.
 *
 * `claimed`: true = a gate closed; false = the gate set did not change (someone
 * else already handled it → the route answers 409); null = not observable
 * (camp_launch, jobs_abort, lfo_abort, push_cancel, or the after-read failed
 * after the action committed).
 */
export type DecideResult =
  | { ok: true; claimed: boolean | null; action: string; target_id: string }
  | { ok: false; status: number; error: string }

/**
 * The edge function's wall clock is ~150 s; an `approve` of a large CSV runs
 * 60–100 s inside it. 170 s gives the function room to finish or be killed
 * before we give up, and stays under the 300 s the Task 9 decide route must
 * declare (`export const maxDuration = 300`) so the Vercel function outlives
 * this fetch. A timeout here means "re-read the gate", never "it failed".
 */
export const DECIDE_TIMEOUT_MS = 170_000

export async function decide(callbackData: string): Promise<DecideResult> {
  // Refuse locally what the entrypoint would refuse with a 400: no round trip.
  if (!parseCallbackData(callbackData)) return { ok: false, status: 400, error: 'bad callback_data' }

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '')
  const secret = process.env.LUME_ACTION_SECRET
  if (!base || !secret) return { ok: false, status: 0, error: 'pipeline entrypoint not configured' }

  let res: Response
  try {
    res = await fetch(`${base}/functions/v1/telegram-inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lume-Secret': secret },
      // `origin` names the caller for the handler's logs and the lfo_count
      // rule (design doc); the entrypoint ignores keys it does not read.
      body: JSON.stringify({ callback_data: callbackData, origin: 'lume' }),
      signal: AbortSignal.timeout(DECIDE_TIMEOUT_MS),
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, status: 0, error: 'timeout' }
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'network error' }
  }

  const text = await res.text()
  let json: Record<string, unknown> | null = null
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    json = null
  }

  if (res.ok && json?.ok === true) {
    const claimed = json.claimed
    return {
      ok: true,
      claimed: claimed === true ? true : claimed === false ? false : null,
      action: String(json.action ?? ''),
      target_id: String(json.target_id ?? ''),
    }
  }

  const error =
    (json && typeof json.error === 'string' && json.error) || text.trim() || `HTTP ${res.status}`
  return { ok: false, status: res.status, error }
}
