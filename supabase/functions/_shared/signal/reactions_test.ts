import { assert, assertEquals } from 'jsr:@std/assert@1'
import { ingestReactorRuns, knownSignalReactorIds, markDigestsReady, normLinkedinUrl, prorate, type Rest } from './reactions.ts'

const RUN = '33333333-3333-4333-8333-333333333333'
const ACTION = '44444444-4444-4444-8444-444444444444'
const NOW = new Date('2026-11-30T12:00:00Z')

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } })

type Call = { path: string; method: string; body: unknown; prefer: string | null }
type Handler = (path: string, init: RequestInit | undefined) => Response | undefined

/** A rest() stub: first handler that answers wins; every call is recorded. */
function fakeRest(handlers: Handler[]): { rest: Rest; calls: Call[] } {
  const calls: Call[] = []
  const rest: Rest = (path, init) => {
    const method = init?.method ?? 'GET'
    const prefer = new Headers(init?.headers).get('Prefer')
    calls.push({ path: decodeURIComponent(path), method, body: init?.body ? JSON.parse(String(init.body)) : null, prefer })
    for (const h of handlers) {
      const r = h(decodeURIComponent(path), init)
      if (r) return Promise.resolve(r)
    }
    return Promise.reject(new Error(`no route for ${method} ${decodeURIComponent(path)}`))
  }
  return { rest, calls }
}

const on = (prefix: string, method: string, respond: (path: string, init?: RequestInit) => Response): Handler =>
  (path, init) => (path.startsWith(prefix) && (init?.method ?? 'GET') === method ? respond(path, init) : undefined)
const ok = () => new Response(null, { status: 204 })

const reactor = (slug: string, o: Record<string, unknown> = {}) => ({
  linkedin_url: `https://www.linkedin.com/in/${slug}/`, linkedin_id: `ID-${slug}`, name: `${slug} Person`, headline: 'Owner at PM Co',
  title: 'Owner', company_name: 'PM Co', company_website: 'https://pmco.com', location: 'Vancouver', door_count: 700,
  door_count_source: 'https://pmco.com/about', door_count_confidence: 'high', verdict: 'verified', exported_at: null, ...o,
})

function doneRunRoutes(opts: { reactors: ReturnType<typeof reactor>[]; existing?: { linkedin_url: string; linkedin_id: string | null }[]; posts?: string[]; counts?: Record<string, number>; cost?: number }) {
  const posts = opts.posts ?? ['111']
  return [
    on('signal_posts?reactions_status=in.(filed,running)', 'GET', () =>
      json(posts.map((p) => ({ post_id: p, reactions_status: 'filed', reactions_action_id: ACTION, reactions_run_id: null })))),
    on('influencer_runs?start_action_id=eq.', 'GET', () => json([{ id: RUN, status: 'done', error: null }])),
    on('influencer_reactors?reacted_posts=cs.', 'GET', (path) => {
      const post = path.match(/cs\.\{(\d+)\}/)![1]
      if (path.includes('select=id&limit=1')) return json([], 200, { 'content-range': `0-0/${opts.counts?.[post] ?? 0}` })
      // server-side filters, as PostgREST applies them
      const rows = opts.reactors.filter((r) => (!path.includes('verdict=eq.verified') || r.verdict === 'verified') && (!path.includes('exported_at=is.null') || r.exported_at === null))
      return json(post === posts[0] ? rows : [])
    }),
    on('signal_people?or=', 'GET', () => json(opts.existing ?? [])),
    on('signal_people?on_conflict=linkedin_url', 'POST', (_p, init) => json(JSON.parse(String(init!.body)), 201)),
    on('influencer_apify_runs?run_id=eq.', 'GET', () => json([{ cost_usd: opts.cost ?? 0.5 }])),
    on('signal_spend?', 'PATCH', ok),
    on('signal_posts?post_id=in.', 'PATCH', ok),
    on('signal_posts?reactions_status=eq.done&digest_status=is.null', 'GET', () => json([])),
  ]
}

Deno.test('normLinkedinUrl: www, https, no query or trailing slash', () => {
  assertEquals(normLinkedinUrl('http://linkedin.com/in/jane-doe/?utm=1'), 'https://www.linkedin.com/in/jane-doe')
  assertEquals(normLinkedinUrl('https://ca.linkedin.com/in/jane'), 'https://www.linkedin.com/in/jane')
  assertEquals(normLinkedinUrl('https://example.com/in/x'), null)
})

Deno.test('prorate: by weight, equal when all zero, sums to the total', () => {
  assertEquals(prorate(1, { a: 30, b: 10 }), { a: 0.75, b: 0.25 })
  assertEquals(prorate(1, { a: 0, b: 0, c: 0 }), { a: 0.3333, b: 0.3333, c: 0.3334 })
})

Deno.test('ingest: a commenter is never downgraded; new verified reactors are inserted with stage by website', async () => {
  const f = fakeRest(doneRunRoutes({
    reactors: [reactor('commenter'), reactor('alice'), reactor('bob', { company_website: null }), reactor('byid', { linkedin_url: 'https://www.linkedin.com/in/other' })],
    existing: [{ linkedin_url: 'https://www.linkedin.com/in/commenter', linkedin_id: null }, { linkedin_url: 'https://www.linkedin.com/in/zzz', linkedin_id: 'ID-byid' }],
  }))
  const out = await ingestReactorRuns(f.rest, NOW)
  assertEquals(out, { ingested: 2 })
  const insert = f.calls.find((c) => c.method === 'POST')!
  assertEquals(insert.prefer, 'resolution=ignore-duplicates,return=representation')
  const rows = insert.body as Record<string, unknown>[]
  assertEquals(rows.map((r) => r.linkedin_url), ['https://www.linkedin.com/in/alice', 'https://www.linkedin.com/in/bob'])
  assertEquals(rows[0], {
    linkedin_url: 'https://www.linkedin.com/in/alice', linkedin_id: 'ID-alice', kind: 'reactor', post_id: '111', reactor_run_id: RUN,
    name: 'alice Person', first_name: 'alice', headline: 'Owner at PM Co', title: 'Owner', company_name: 'PM Co', company_website: 'https://pmco.com',
    company_guess: null, location: 'Vancouver', door_count: 700, door_count_source: 'https://pmco.com/about', door_count_confidence: 'high',
    stage: 'crawl', skip_reason: null,
  })
  assertEquals([rows[1].stage, rows[1].skip_reason], ['skipped', 'no_website'])
  assert(!f.calls.some((c) => c.method === 'PATCH' && c.path.startsWith('signal_people')), 'existing people are never patched')
})

Deno.test('ingest: exported or unverified reactors are skipped', async () => {
  const f = fakeRest(doneRunRoutes({
    reactors: [reactor('exported', { exported_at: '2026-11-01T00:00:00Z' }), reactor('rejected', { verdict: 'rejected' }), reactor('pending', { verdict: null })],
  }))
  assertEquals(await ingestReactorRuns(f.rest, NOW), { ingested: 0 })
  const get = f.calls.find((c) => c.path.startsWith('influencer_reactors?') && c.path.includes('verdict'))!
  assert(get.path.includes('verdict=eq.verified') && get.path.includes('exported_at=is.null'), get.path)
  assert(!f.calls.some((c) => c.method === 'POST'), 'nothing inserted')
})

Deno.test('ingest: reservations settle to the actual reactions cost, pro-rated by reactions; posts done', async () => {
  const f = fakeRest(doneRunRoutes({ reactors: [], posts: ['111', '222'], counts: { '111': 30, '222': 10 }, cost: 1 }))
  await ingestReactorRuns(f.rest, NOW)
  const settles = f.calls.filter((c) => c.method === 'PATCH' && c.path.startsWith('signal_spend'))
  assertEquals(settles.map((c) => [c.path, c.body]), [
    ['signal_spend?lane=eq.reactions_apify&status=eq.reserved&post_id=eq.111', { status: 'settled', usd: 0.75, settled_at: NOW.toISOString() }],
    ['signal_spend?lane=eq.reactions_apify&status=eq.reserved&post_id=eq.222', { status: 'settled', usd: 0.25, settled_at: NOW.toISOString() }],
  ])
  const done = f.calls.find((c) => c.method === 'PATCH' && c.path.startsWith('signal_posts?post_id=in.'))!
  assert(done.path.includes('reactions_status=in.(filed,running)'), 'status only moves forward')
  assertEquals((done.body as Record<string, unknown>).reactions_status, 'done')
})

Deno.test('ingest: a running run marks posts running; a failed run skips them and releases the reservation', async () => {
  for (const [status, want] of [['running', 'running'], ['failed', 'skipped']] as const) {
    const f = fakeRest([
      on('signal_posts?reactions_status=in.(filed,running)', 'GET', () => json([{ post_id: '111', reactions_status: 'filed', reactions_action_id: ACTION, reactions_run_id: null }])),
      on('influencer_runs?start_action_id=eq.', 'GET', () => json([{ id: RUN, status, error: status === 'failed' ? 'boom' : null }])),
      on('signal_posts?post_id=in.', 'PATCH', ok),
      on('signal_spend?', 'PATCH', ok),
      on('signal_posts?reactions_status=eq.done', 'GET', () => json([])),
    ])
    await ingestReactorRuns(f.rest, NOW)
    const patch = f.calls.find((c) => c.path.startsWith('signal_posts?post_id=in.'))!
    assertEquals((patch.body as Record<string, unknown>).reactions_status, want)
    assertEquals((patch.body as Record<string, unknown>).reactions_run_id, RUN)
    const release = f.calls.find((c) => c.path.startsWith('signal_spend'))
    if (status === 'failed') assertEquals((release!.body as Record<string, unknown>).status, 'released')
    else assert(!release, 'nothing released while running')
  }
})

Deno.test('ingest: a rejected card skips its posts and releases; an awaiting card waits', async () => {
  for (const [status, skipped] of [['rejected', true], ['awaiting', false]] as const) {
    const f = fakeRest([
      on('signal_posts?reactions_status=in.(filed,running)', 'GET', () => json([{ post_id: '111', reactions_status: 'filed', reactions_action_id: ACTION, reactions_run_id: null }])),
      on('influencer_runs?start_action_id=eq.', 'GET', () => json([])),
      on('pending_actions?id=eq.', 'GET', () => json([{ status }])),
      on('signal_posts?post_id=in.', 'PATCH', ok),
      on('signal_spend?', 'PATCH', ok),
      on('signal_posts?reactions_status=eq.done', 'GET', () => json([])),
    ])
    await ingestReactorRuns(f.rest, NOW)
    assertEquals(f.calls.some((c) => c.method === 'PATCH'), skipped)
  }
})

Deno.test('markDigestsReady: null while a reactor is mid-pipeline; ready when one reached ready; else empty', async () => {
  const f = fakeRest([
    on('signal_posts?reactions_status=eq.done&digest_status=is.null', 'GET', () => json([{ post_id: '1' }, { post_id: '2' }, { post_id: '3' }, { post_id: '4' }])),
    on('signal_people?kind=eq.reactor', 'GET', () => json([
      { post_id: '1', stage: 'ready' }, { post_id: '1', stage: 'crawl' },
      { post_id: '2', stage: 'alerted' }, { post_id: '2', stage: 'skipped' },
      { post_id: '3', stage: 'skipped' }, { post_id: '3', stage: 'error' },
    ])),
    on('signal_posts?post_id=eq.', 'PATCH', ok),
  ])
  await markDigestsReady(f.rest)
  const patches = f.calls.filter((c) => c.method === 'PATCH').map((c) => [c.path, (c.body as Record<string, unknown>).digest_status])
  assertEquals(patches, [
    ['signal_posts?post_id=eq.2&digest_status=is.null', 'ready'],
    ['signal_posts?post_id=eq.3&digest_status=is.null', 'empty'],
    ['signal_posts?post_id=eq.4&digest_status=is.null', 'empty'],
  ])
})

Deno.test('knownSignalReactorIds: signal run → reactors already in signal_people (url or id); other runs → []', async () => {
  const rows = [
    { id: 1, linkedin_url: 'https://www.linkedin.com/in/known/', linkedin_id: 'X1' },
    { id: 2, linkedin_url: 'https://www.linkedin.com/in/new', linkedin_id: 'X2' },
    { id: 3, linkedin_url: 'https://www.linkedin.com/in/renamed', linkedin_id: 'X3' },
  ]
  const signal = fakeRest([
    on('influencer_runs?id=eq.run-a', 'GET', () => json([{ start_action_id: ACTION }])),
    on('signal_posts?reactions_action_id=eq.', 'GET', () => json([{ post_id: '111' }])),
    on('signal_people?or=', 'GET', () => json([{ linkedin_url: 'https://www.linkedin.com/in/known', linkedin_id: null }, { linkedin_url: 'https://www.linkedin.com/in/x', linkedin_id: 'X3' }])),
  ])
  assertEquals(await knownSignalReactorIds(signal.rest, 'run-a', rows), [1, 3])
  assertEquals(signal.calls.filter((c) => c.path.startsWith('signal_people')).length, 1, 'one query per batch')

  const other = fakeRest([
    on('influencer_runs?id=eq.run-b', 'GET', () => json([{ start_action_id: ACTION }])),
    on('signal_posts?reactions_action_id=eq.', 'GET', () => json([])),
  ])
  assertEquals(await knownSignalReactorIds(other.rest, 'run-b', rows), [])

  const unmigrated = fakeRest([
    on('influencer_runs?id=eq.run-c', 'GET', () => json([{ start_action_id: ACTION }])),
    on('signal_posts?', 'GET', () => json({ message: 'relation does not exist' }, 404)),
  ])
  assertEquals(await knownSignalReactorIds(unmigrated.rest, 'run-c', rows), [])
})
