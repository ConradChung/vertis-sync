// Run: deno test --allow-env company-check/
import { assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, type Route, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', ANTHROPIC_API_KEY: 'ant-key', PERPLEXITY_API_KEY: 'pplx-key' })
const { finishText, handle, runChecks } = await import('./index.ts')

const JOB = '11111111-1111-4111-8111-111111111111'
const ACTION = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'
const ICP = 'a property management company'
const IKEY = 'a'.repeat(64)

const post = (body: unknown, auth = 'Bearer svc') =>
  new Request('https://fn.test/company-check', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) })
const is = (path: string, method: string) => (u: string, m: string) => u.startsWith(`https://db.test/rest/v1/${path}`) && m === method
const bodies = (calls: { url: string; method: string; body: string | null }[], match: (u: string, m: string) => boolean) =>
  calls.filter((c) => match(c.url, c.method)).map((c) => ({ url: c.url, body: JSON.parse(c.body ?? 'null') }))
const clock = () => {
  let t = 0
  return { now: () => t, sleep: (ms: number) => { t += ms; return Promise.resolve() }, tick: (ms: number) => { t += ms } }
}
const noWait = () => {}
const startBody = { action: 'start', job_id: JOB, max_usd: 25, action_id: ACTION }

const approved = (o: Record<string, unknown> = {}) =>
  [is('pending_actions?id=eq.', 'GET'), () => json([{ kind: 'company_check', status: 'executing', payload: { job_id: JOB, icp: ICP, estimate_usd: 21.82 }, ...o }])] as Route
const openRun = (run: Record<string, unknown>) => [is('rpc/company_check_open_run', 'POST'), () => json({ id: RUN, status: 'staged', spent_usd: 0, action_id: null, ...run })] as Route

const pplx = () => json({ choices: [{ message: { content: 'Acme manages 400 rental doors for owners.' } }], citations: ['https://acmepm.com/about'], usage: { cost: { total_cost: 0.0061 } } })
const haiku = (fit = 'fit') => json({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ what_it_does: 'Residential property manager.', icp_fit: fit, confidence: 'high', evidence: 'manages 400 doors', evidence_url: 'https://acmepm.com/about', property_type: 'residential', doors: 400, doors_evidence: '400 doors (acmepm.com/about)' }) }],
  usage: { input_tokens: 1000, output_tokens: 100 },
})

Deno.test('auth: no bearer or a wrong one -> 401, nothing called', async () => {
  const f = stubFetch([])
  try {
    for (const a of ['', 'Bearer nope']) assertEquals((await handle(post({ action: 'sweep' }, a), noWait)).status, 401)
    assertEquals(f.calls.length, 0)
  } finally { f.restore() }
})

Deno.test('start: bad input -> 400 before any read', async () => {
  const f = stubFetch([])
  try {
    for (const b of [{ ...startBody, max_usd: 0 }, { ...startBody, max_usd: 51 }, { ...startBody, job_id: 'x' }, { ...startBody, action_id: undefined }]) {
      assertEquals((await handle(post(b), noWait)).status, 400)
    }
    assertEquals(f.calls.length, 0)
  } finally { f.restore() }
})

Deno.test('start: opens the run for the approved ICP, seeds it, raises the cap on top of what was spent, flips to running and kicks the chain', async () => {
  const kicked: Promise<unknown>[] = []
  const f = stubFetch([
    approved(),
    openRun({ status: 'capped', spent_usd: 3.5 }),
    [is('rpc/company_check_seed', 'POST'), () => json({ items: { pending: 10, cached: 2 } })],
    [is('company_check_runs?id=eq.', 'PATCH'), (_u, b) => json([{ id: RUN, ...JSON.parse(b!) }])],
  ])
  try {
    const res = await handle(post(startBody), (p) => kicked.push(p), { run: () => Promise.resolve() })
    assertEquals(res.status, 202)
    assertEquals((await res.json()).max_usd, 28.5)
    // An action filed without a scope runs over every valid lead.
    assertEquals(bodies(f.calls, is('rpc/company_check_open_run', 'POST'))[0].body, { p_job_id: JOB, p_icp: ICP, p_scope: 'all' })
    const patch = bodies(f.calls, is('company_check_runs?id=eq.', 'PATCH'))[0]
    assertEquals(patch.url.includes('status=eq.capped'), true)
    assertEquals([patch.body.status, patch.body.max_usd, patch.body.action_id, patch.body.estimate_usd], ['running', 28.5, ACTION, 21.82])
    assertEquals(kicked.length, 1)
  } finally { f.restore() }
})

Deno.test('start: the approved scope picks the run (sending = still in the lead bank); a bad scope is refused', async () => {
  const f = stubFetch([
    approved({ payload: { job_id: JOB, icp: ICP, scope: 'sending' } }),
    openRun({}),
    [is('rpc/company_check_seed', 'POST'), () => json({ items: { pending: 3 } })],
    [is('company_check_runs?id=eq.', 'PATCH'), (_u, b) => json([{ id: RUN, ...JSON.parse(b!) }])],
  ])
  try {
    assertEquals((await handle(post(startBody), noWait, { run: () => Promise.resolve() })).status, 202)
    assertEquals(bodies(f.calls, is('rpc/company_check_open_run', 'POST'))[0].body.p_scope, 'sending')
  } finally { f.restore() }
  const g = stubFetch([approved({ payload: { job_id: JOB, icp: ICP, scope: 'everything' } })])
  try {
    const res = await handle(post(startBody), noWait, { run: () => Promise.resolve() })
    assertEquals([res.status, (await res.json()).error], [400, 'bad_scope'])
    assertEquals(g.calls.length, 1)
  } finally { g.restore() }
})

Deno.test('start: defence in depth — only an approved company_check for this job, with an ICP', async () => {
  const cases: Route[] = [
    approved({ kind: 'influencer_lookup' }),
    approved({ status: 'awaiting' }),
    approved({ payload: { job_id: '99999999-9999-4999-8999-999999999999', icp: ICP } }),
    approved({ payload: { job_id: JOB } }),
    [is('pending_actions?id=eq.', 'GET'), () => json([])],
  ]
  for (const route of cases) {
    const f = stubFetch([route])
    try {
      const res = await handle(post(startBody), noWait, { run: () => Promise.resolve() })
      assertEquals([res.status, (await res.json()).error], [403, 'action_not_approved'])
      assertEquals(f.calls.length, 1)
    } finally { f.restore() }
  }
})

Deno.test('start: the same approval never spends twice; a run already running for another approval is 409', async () => {
  for (const [run, status, error] of [
    [{ status: 'done', action_id: ACTION }, 409, 'action_already_used'],
    [{ status: 'running', action_id: ACTION }, 202, undefined],
    [{ status: 'running', action_id: '44444444-4444-4444-8444-444444444444' }, 409, 'run_in_progress'],
  ] as [Record<string, unknown>, number, string | undefined][]) {
    const f = stubFetch([approved(), openRun(run)])
    try {
      const res = await handle(post(startBody), noWait, { run: () => Promise.resolve() })
      assertEquals([res.status, (await res.json()).error], [status, error])
      assertEquals(f.calls.some((c) => c.method === 'PATCH' || c.url.includes('company_check_seed')), false)
    } finally { f.restore() }
  }
})

function chainRoutes(opts: { cap: number; spent?: number; pages: Record<string, unknown>[][]; cached?: string[] }) {
  let page = 0
  return [
    [is('company_check_runs?id=eq.', 'PATCH'), (_u, b) => json([{ id: RUN, status: 'running', icp_description: ICP, icp_key: IKEY, spent_usd: opts.spent ?? 0, max_usd: opts.cap, estimate_usd: 0.02, ...JSON.parse(b!) }])],
    [is('company_check_items?run_id=eq.', 'GET'), () => json(opts.pages[page++] ?? [])],
    [is('company_check_items?run_id=eq.', 'PATCH'), () => new Response(null, { status: 204 })],
    [is('company_checks?company_key=eq.', 'GET'), (u) => json((opts.cached ?? []).some((k) => u.includes(`company_key=eq.${encodeURIComponent(k)}&`)) ? [{ id: 'c' }] : [])],
    [is('company_checks?on_conflict', 'POST'), () => new Response(null, { status: 201 })],
    [is('rpc/company_check_summary', 'POST'), () => json({ items: { done: 1, cached: 1 }, companies_by_fit: { fit: 2 }, leads_by_fit: { fit: 5 }, companies_by_type: { residential: 2 }, leads_by_type: { residential: 5 } })],
    [is('rpc/lume_alert_upsert', 'POST'), () => json('a1')],
  ] as Route[]
}

Deno.test('runChecks: a cached company costs nothing; a new one is researched, cached and tallied at its real cost; finishes done', async () => {
  const f = stubFetch([
    ...chainRoutes({ cap: 1, cached: ['old.com'], pages: [[{ company_key: 'acmepm.com', company_name: 'Acme PM', website: 'acmepm.com', attempts: 0 }, { company_key: 'old.com', company_name: 'Old', website: null, attempts: 0 }], []] }),
    [(u) => u === 'https://api.perplexity.ai/chat/completions', () => pplx()],
    [(u) => u === 'https://api.anthropic.com/v1/messages', () => haiku()],
  ])
  try {
    const c = clock()
    await runChecks(RUN, null, { now: c.now, sleep: c.sleep, handOff: () => Promise.resolve(true) })
    assertEquals(f.calls.filter((x) => x.url.includes('perplexity')).length, 1)
    const cache = bodies(f.calls, is('company_checks?on_conflict', 'POST'))
    assertEquals(cache.length, 1)
    assertEquals([cache[0].body.company_key, cache[0].body.icp_key, cache[0].body.icp_fit, cache[0].body.evidence_url], ['acmepm.com', IKEY, 'fit', 'https://acmepm.com/about'])
    // The same single Perplexity call also gives the property type and doors.
    assertEquals([cache[0].body.property_type, cache[0].body.doors, cache[0].body.doors_evidence], ['residential', 400, '400 doors (acmepm.com/about)'])
    const items = bodies(f.calls, is('company_check_items?run_id=eq.', 'PATCH'))
    assertEquals(items.every((x) => x.url.includes('status=eq.pending')), true)
    assertEquals(items.map((x) => x.body.status).sort(), ['cached', 'done'])
    const runPatches = bodies(f.calls, is('company_check_runs?id=eq.', 'PATCH')).map((x) => x.body)
    // 0.0061 Perplexity + Haiku 1000 in / 100 out at $0.10 / $0.50 per M (0.00015) = 0.00625
    assertEquals(runPatches.some((b) => b.spent_usd === 0.00625), true)
    assertEquals(runPatches.at(-1)!.status, 'done')
    const alert = bodies(f.calls, is('rpc/lume_alert_upsert', 'POST'))[0]
    assertEquals(JSON.stringify(alert.body).includes('By property type: residential 2 (5 leads)'), true)
  } finally { f.restore() }
})

Deno.test('finishText: verdicts plus counts by property type (companies and leads), scope named', () => {
  const s = {
    items: { done: 5, error: 1 },
    companies_by_fit: { fit: 3, not_fit: 2 },
    leads_by_fit: { fit: 7, not_fit: 4 },
    companies_by_type: { multifamily: 1, residential: 3, commercial: 1 },
    leads_by_type: { multifamily: 2, residential: 7, commercial: 2 },
  }
  const done = finishText('done', s, { spent: 0.04, cap: 1, estimate: 0.05, scope: 'sending' })
  assertEquals(done.startsWith('Company check of the still-sending leads finished: $0.04 spent (estimate $0.05).'), true)
  assertEquals(done.includes('Fit 3 companies (7 leads), not fit 2 (4 leads), unclear 0; 1 failed.'), true)
  assertEquals(done.endsWith('By property type: residential 3 (7 leads), multifamily 1 (2 leads), commercial 1 (2 leads).'), true)
  const capped = finishText('capped', { items: { pending: 9 } }, { spent: 1, cap: 1, estimate: null, scope: 'all' })
  assertEquals(capped, 'Company check stopped at its $1.00 cap ($1.00 spent) with 9 companies still unchecked. Ask Lume to check the rest.')
})

Deno.test('runChecks: stops at the hard cap (capped) without calling Perplexity past it', async () => {
  const f = stubFetch(chainRoutes({ cap: 0.005, pages: [[{ company_key: 'acmepm.com', company_name: 'Acme', website: null, attempts: 0 }]] }))
  try {
    const c = clock()
    await runChecks(RUN, null, { now: c.now, sleep: c.sleep, handOff: () => Promise.resolve(true) })
    assertEquals(f.calls.some((x) => x.url.includes('perplexity')), false)
    assertEquals(bodies(f.calls, is('company_check_runs?id=eq.', 'PATCH')).at(-1)!.body.status, 'capped')
  } finally { f.restore() }
})

Deno.test('runChecks: a pair starts only with >= 75 s of wall clock left; then it hands off', async () => {
  const c = clock()
  let handed = 0
  const f = stubFetch([
    ...chainRoutes({ cap: 1, pages: [[{ company_key: 'a.com', company_name: 'A', website: null, attempts: 0 }], [{ company_key: 'b.com', company_name: 'B', website: null, attempts: 0 }]] }),
    [(u) => u === 'https://api.perplexity.ai/chat/completions', () => { c.tick(76_000); return pplx() }],
    [(u) => u === 'https://api.anthropic.com/v1/messages', () => haiku()],
  ])
  try {
    await runChecks(RUN, null, { now: c.now, sleep: c.sleep, handOff: () => { handed++; return Promise.resolve(true) } })
    assertEquals(f.calls.filter((x) => x.url.includes('perplexity')).length, 1)
    assertEquals(handed, 1)
  } finally { f.restore() }
})

Deno.test('runChecks: a lease held elsewhere -> nothing happens', async () => {
  const f = stubFetch([[is('company_check_runs?id=eq.', 'PATCH'), () => json([])]])
  try {
    await runChecks(RUN, null, { handOff: () => Promise.resolve(true) })
    assertEquals(f.calls.length, 1)
  } finally { f.restore() }
})

Deno.test('runChecks: the second failure marks the company error, with the message', async () => {
  const f = stubFetch([
    ...chainRoutes({ cap: 1, pages: [[{ company_key: 'a.com', company_name: 'A', website: null, attempts: 1 }], []] }),
    [(u) => u === 'https://api.perplexity.ai/chat/completions', () => json({ error: 'bad' }, 400)],
  ])
  try {
    const c = clock()
    await runChecks(RUN, null, { now: c.now, sleep: c.sleep, handOff: () => Promise.resolve(true) })
    const b = bodies(f.calls, is('company_check_items?run_id=eq.', 'PATCH'))[0].body
    assertEquals([b.status, b.attempts, String(b.error).startsWith('Perplexity 400')], ['error', 2, true])
    assertEquals(bodies(f.calls, is('company_checks?on_conflict', 'POST')).length, 0)
  } finally { f.restore() }
})

Deno.test('sweep: re-kicks running runs whose lease expired', async () => {
  const kicked: Promise<unknown>[] = []
  const f = stubFetch([[is('company_check_runs?status=eq.running', 'GET'), () => json([{ id: RUN }])]])
  try {
    const res = await handle(post({ action: 'sweep' }), (p) => kicked.push(p), { run: () => Promise.resolve() })
    assertEquals(await res.json(), { ok: true, kicked: 1 })
    assertEquals(kicked.length, 1)
  } finally { f.restore() }
})
