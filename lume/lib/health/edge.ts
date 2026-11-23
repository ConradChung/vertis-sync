import { EDGE_ENV_NAMES } from '@/lib/health/names'
import { CHECK_TIMEOUT_MS } from '@/lib/health/checks'
import type { EdgePresence, Env, FetchLike, PresenceRow } from '@/lib/health/model'

/**
 * Which edge-function secrets are set, from the `config-health` edge function
 * (service role only; it answers `{ names: { NAME: boolean } }`). Pure, fetch
 * and env injected. Only `true` counts as present, only listed names are
 * kept, and nothing but booleans leaves this function.
 */
export async function fetchEdgePresence(fetch: FetchLike, env: Env): Promise<EdgePresence> {
  const unknown: PresenceRow[] = EDGE_ENV_NAMES.map((n) => ({ name: n.name, required: n.required, present: false }))
  const base = env('NEXT_PUBLIC_SUPABASE_URL')?.trim().replace(/\/+$/, '')
  const key = env('SUPABASE_SERVICE_ROLE_KEY')?.trim()
  if (!base || !key) return { ok: false, error: 'NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing', names: unknown }
  let res: Response
  try {
    res = await fetch(`${base}/functions/v1/config-health`, {
      method: 'GET',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return { ok: false, error: timeout ? 'config-health timed out' : 'config-health unreachable', names: unknown }
  }
  const body = (await res.json().catch(() => null)) as { names?: unknown } | null
  if (res.status === 404) return { ok: false, error: 'config-health is not deployed (404)', names: unknown }
  if (res.status === 401 || res.status === 403) return { ok: false, error: `config-health refused the service key (${res.status})`, names: unknown }
  const names = body?.names
  if (!res.ok || !names || typeof names !== 'object' || Array.isArray(names)) return { ok: false, error: `config-health answered HTTP ${res.status}`, names: unknown }
  const map = names as Record<string, unknown>
  return { ok: true, names: EDGE_ENV_NAMES.map((n) => ({ name: n.name, required: n.required, present: map[n.name] === true })) }
}
