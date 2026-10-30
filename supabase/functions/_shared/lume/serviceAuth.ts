import { secretsMatch } from './action.ts'

/**
 * Keys that identify a service-role caller: the legacy SUPABASE_SERVICE_ROLE_KEY
 * JWT and every new `sb_secret_…` key in SUPABASE_SECRET_KEYS (a JSON object
 * keyed by name). Lume and the vault hold a new secret key while the runtime's
 * SUPABASE_SERVICE_ROLE_KEY is still the legacy JWT, so both must be accepted.
 */
export function serviceKeys(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): string[] {
  const keys = new Set<string>()
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) keys.add(legacy)
  try {
    const parsed = JSON.parse(env('SUPABASE_SECRET_KEYS') ?? '{}')
    if (parsed && typeof parsed === 'object') {
      for (const v of Object.values(parsed)) if (typeof v === 'string' && v) keys.add(v)
    }
  } catch {
    // malformed: the legacy key alone
  }
  return [...keys]
}

/** The request carries a service key on `Authorization: Bearer` or `apikey` (constant-time compare). */
export async function isServiceCaller(req: Request, env?: (k: string) => string | undefined): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? ''
  const candidates = [auth.startsWith('Bearer ') ? auth.slice(7).trim() : '', (req.headers.get('apikey') ?? '').trim()].filter(Boolean)
  const keys = serviceKeys(env)
  let ok = false
  // Every pair is compared, so timing doesn't reveal which key matched.
  for (const c of candidates) for (const k of keys) ok = (await secretsMatch(c, k)) || ok
  return ok
}
