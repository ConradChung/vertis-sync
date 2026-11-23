// Supabase Edge Function: config-health — which edge-function secrets are set.
//
// GET or POST (no body) -> { names: { NAME: true | false } } for every name in
// EDGE_SECRET_NAMES (the root .env.example's edge-secret block). Presence only:
// a value is never read beyond "non-empty", never returned and never logged.
//
// Caller: service role only (isServiceCaller), i.e. Lume's Settings -> Config
// health server route with SUPABASE_SERVICE_ROLE_KEY. Deployed JWT-verified.
import { isServiceCaller } from '../_shared/lume/serviceAuth.ts'
import { EDGE_SECRET_NAMES } from './names.ts'

type Env = (k: string) => string | undefined

const reply = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

/** `{ NAME: present }` for each listed name; booleans only. */
export function presence(env: Env, names: readonly string[] = EDGE_SECRET_NAMES): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const n of names) out[n] = (env(n) ?? '').trim().length > 0
  return out
}

export async function handle(req: Request, env: Env = (k) => Deno.env.get(k)): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  if (!(await isServiceCaller(req, env))) return reply({ error: 'unauthorized' }, 401)
  return reply({ names: presence(env) }, 200)
}

Deno.serve((req) => handle(req))
