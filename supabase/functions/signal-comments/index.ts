// Supabase Edge Function: signal-comments — GTM-14 comments lane.
//
// POST { action: 'tick', force?: { posts_7d?: boolean, posts_48h?: boolean } }
//
// Polls Frank's LinkedIn posts and their comments, dedupes commenters against
// Lume, filters them to property-management operators (Haiku headline triage,
// Perplexity verify, crawl worker PM-vs-vendor, door count, Blitz work email)
// and writes template drafts. Rows at stage 'ready' are carded to #sales by
// Lume (/api/cron/signal-alerts); nothing here sends anything to a lead.
//
// Spend runs under the owner's standing approval for this lane only (repo
// CLAUDE.md), capped per Apify cycle and per PT day (_shared/signal/caps.ts).
// signal_config.dry_run does not stop this function; it only stops Lume
// posting to Slack.
//
// Caller: service role only (the pg_cron tick). One tick at a time (lease
// RPC signal_claim_tick); a concurrent call returns { ok: true, skipped: 'leased' }.

import { isServiceCaller } from '../_shared/lume/serviceAuth.ts'
import { parseJsonResponse, type JsonRequest } from '../_shared/influencer/haiku.ts'
import { haikuUsd } from '../_shared/influencer/cost.ts'
import { parsePerplexity, perplexityRequest, PPLX_URL, type PplxAnswer, RETRY_BACKOFF_MS, retryable } from '../_shared/influencer/verify.ts'
import { deepWellFormed } from '../_shared/text.ts'
import { apifyClient } from '../_shared/signal/apify.ts'
import type { Facts } from '../_shared/signal/drafts.ts'
import { crawlClient } from '../_shared/signal/filter.ts'
import { BlitzSession } from '../_shared/blitz.ts'
import { ingestReactorRuns } from '../_shared/signal/reactions.ts'
import { type Rest, restStore } from '../_shared/signal/store.ts'
import { runTick, type TickBody } from '../_shared/signal/tick.ts'
import factsJson from '../_shared/signal/frank-facts.json' with { type: 'json' }

const env = (k: string) => Deno.env.get(k) ?? ''
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const HAIKU_TIMEOUT_MS = 30_000
const PPLX_TIMEOUT_MS = 40_000

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export function serviceRest(url: string, key: string, f: typeof fetch = fetch): Rest {
  return (path, init = {}) =>
    f(`${url}/rest/v1/${path}`, {
      ...init,
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
}

async function haiku(req: JsonRequest): Promise<{ json: unknown; usd: number }> {
  const key = env('ANTHROPIC_API_KEY')
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set')
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify(deepWellFormed(req)),
    signal: AbortSignal.timeout(HAIKU_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const { json, usage } = parseJsonResponse(await res.json())
  return { json, usd: haikuUsd(usage) }
}

/** Perplexity with a short backoff on 429 / 5xx (two retries at most inside the tick). */
async function perplexity(question: string): Promise<PplxAnswer> {
  const key = env('PERPLEXITY_API_KEY')
  if (!key) throw new Error('PERPLEXITY_API_KEY is not set')
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(PPLX_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(deepWellFormed(perplexityRequest(question))),
      signal: AbortSignal.timeout(PPLX_TIMEOUT_MS),
    })
    if (res.ok) return parsePerplexity(await res.json())
    const text = (await res.text()).slice(0, 200)
    if (!retryable(res.status) || attempt >= 1) throw new Error(`Perplexity ${res.status}: ${text}`)
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[0]))
  }
}

export async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return reply({ ok: false, error: 'method_not_allowed' }, 405)
  if (!(await isServiceCaller(req))) return reply({ ok: false, error: 'unauthorized' }, 401)
  let body: { action?: unknown; force?: unknown }
  try {
    body = await req.json()
  } catch {
    return reply({ ok: false, error: 'bad_json' }, 400)
  }
  if (body?.action !== 'tick') return reply({ ok: false, error: 'unknown_action' }, 400)
  const f = (body.force && typeof body.force === 'object' ? body.force : {}) as Record<string, unknown>
  const tickBody: TickBody = { force: { posts_7d: f.posts_7d === true, posts_48h: f.posts_48h === true } }

  const rest = serviceRest(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))
  const crawlUrl = env('CRAWL_WORKER_URL')
  const crawlSecret = env('CRAWL_WORKER_SECRET')
  try {
    const out = await runTick({
      store: restStore(rest),
      apify: apifyClient(env('APIFY_API_TOKEN')),
      rest,
      ingestReactorRuns,
      haiku,
      perplexity,
      crawl: crawlUrl && crawlSecret ? crawlClient(crawlUrl, crawlSecret) : null,
      // Unset BLITZ_API_KEY → cards ship without an email, as before.
      email: new BlitzSession({ apiKey: env('BLITZ_API_KEY') }),
      facts: factsJson as Facts,
      clock: () => Date.now(),
    }, tickBody)
    console.log('[signal-comments]', JSON.stringify(out).slice(0, 2000))
    return reply(out)
  } catch (err) {
    console.error('[signal-comments] tick failed:', err)
    return reply({ ok: false, error: err instanceof Error ? err.message.slice(0, 300) : 'tick_failed' }, 500)
  }
}

Deno.serve((req) => handle(req))
