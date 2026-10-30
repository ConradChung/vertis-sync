import 'server-only'

/**
 * The `influencer-reactions` edge function (service role). Called only by the
 * executor of an approved `influencer_run` / `influencer_reactions` pending
 * action, and by the low-risk cancel (which only stops spending).
 */

export const INFLUENCER_FN_TIMEOUT_MS = 60_000

export type InfluencerFnResult = { ok: true; status: number; body: Record<string, unknown> } | { ok: false; status: number; error: string }

export async function callInfluencerFn(body: Record<string, unknown>): Promise<InfluencerFnResult> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '')
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!base || !key) return { ok: false, status: 0, error: 'not_configured' }
  try {
    const res = await fetch(`${base}/functions/v1/influencer-reactions`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(INFLUENCER_FN_TIMEOUT_MS),
      cache: 'no-store',
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok || !json || json.ok !== true) {
      const error = typeof json?.error === 'string' ? json.error : `http_${res.status}`
      console.error(`[influencer-reactions] ${String(body.action ?? 'call')} HTTP ${res.status}: ${error}`)
      return { ok: false, status: res.status, error }
    }
    return { ok: true, status: res.status, body: json }
  } catch (err) {
    console.error('[influencer-reactions]', err instanceof Error ? err.message : err)
    return { ok: false, status: 0, error: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'unreachable' }
  }
}
