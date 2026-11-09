// Run: deno test --allow-env instantly-push/
import { assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTANTLY_API_KEY: 'ik' })
const { bankRow, createLead, decideRow, loadActiveJurisdictions, loadBankThreshold, processJob, pushRoute, verifyFirstLead } = await import('./index.ts')

const KASPEN = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
// One generic fallback for every client (no per-campaign sentences any more).
const FALLBACK = 'local landlord-tenant law'
const BC_LAW = 'Residential Tenancy Act'

const job = {
  id: 'j1', filename: 'f.csv', icp_filter: false, column_order: null,
  instantly_campaign_id: KASPEN, instantly_campaign_name: 'Zenport',
  instantly_campaign_id_nolocation: null, instantly_campaign_name_nolocation: null,
  instantly_pushed_nolocation: 0, instantly_pushed: 0, instantly_filtered: 0, instantly_errors: 0,
  location_barrier: false, company_barrier: true, company_strict: false,
}
const cols = { company: 'Company Name', website: 'Website', first: 'First Name', last: 'Last Name' }
const rows = [
  { country: 'CA', region: 'British Columbia', city_match: null, jurisdiction: 'British Columbia', compliance_name: BC_LAW, short_name: null, active: true },
  { country: 'US', region: 'Texas', city_match: null, jurisdiction: 'Texas', compliance_name: null, short_name: null, active: true },
]
const ctx = { rows }
const vrow = (extra: Record<string, unknown>) => ({
  id: 'r1', row_index: 0, email: 'a@acme.com',
  row_data: { 'First Name': 'Ann', 'Last Name': 'Lee', 'Company Name': 'Acme Properties LLC', operating_city: 'Vancouver', ...extra },
})
// deno-lint-ignore no-explicit-any
const keep = (d: any) => { if (!d.keep) throw new Error(`dropped: ${d.reason}`); return d.lead }

Deno.test('decideRow: certain country + region -> ISO2, canonical region and the compliance law', () => {
  const lead = keep(decideRow(vrow({ Country: 'Canada', State: 'BC' }), cols, job, ctx))
  assertEquals([lead.country, lead.region, lead.complianceLaw], ['CA', 'British Columbia', BC_LAW])
})

Deno.test('decideRow: falls back to Company Country / Company State', () => {
  const lead = keep(decideRow(vrow({ Country: '', State: '', 'Company Country': 'Canada', 'Company State': 'British Columbia' }), cols, job, ctx))
  assertEquals([lead.country, lead.region, lead.complianceLaw], ['CA', 'British Columbia', BC_LAW])
})

Deno.test('decideRow: an active row with no compliance_name is no match -> the fallback', () => {
  const lead = keep(decideRow(vrow({ Country: 'United States', State: 'Texas' }), cols, job, ctx))
  assertEquals([lead.country, lead.region, lead.complianceLaw], ['US', 'Texas', FALLBACK])
})

Deno.test('decideRow: uncertain country -> no country/region, fallback sentence', () => {
  for (const extra of [{}, { Country: 'Narnia', State: 'BC' }, { State: 'BC' }]) {
    const lead = keep(decideRow(vrow(extra), cols, job, ctx))
    assertEquals([lead.country, lead.region, lead.complianceLaw], ['', '', FALLBACK], JSON.stringify(extra))
  }
})

Deno.test('decideRow: region is dropped when it is not a region of that country', () => {
  const lead = keep(decideRow(vrow({ Country: 'Canada', State: 'Texas' }), cols, job, ctx))
  assertEquals([lead.country, lead.region, lead.complianceLaw], ['CA', '', FALLBACK])
})

Deno.test('decideRow: without a context (preview) the law is the generic fallback, whatever the campaign', () => {
  assertEquals(keep(decideRow(vrow({ Country: 'Canada', State: 'BC' }), cols, job)).complianceLaw, FALLBACK)
  const other = { ...job, instantly_campaign_id: 'other' }
  assertEquals(keep(decideRow(vrow({}), cols, other)).complianceLaw, FALLBACK)
})

Deno.test('decideRow: location and operating cities unchanged', () => {
  const lead = keep(decideRow(vrow({ secondary_cities: 'Burnaby' }), cols, job, ctx))
  assertEquals([lead.location, lead.operatingCities, lead.company_name], ['Vancouver', 'Vancouver; Burnaby', 'Acme Properties'])
})

function instantlyStub() {
  return stubFetch([[(u, m) => u === 'https://api.instantly.ai/api/v2/leads' && m === 'POST', () => json({ id: 'L1' })]])
}
const baseLead = {
  email: 'a@acme.com', first_name: 'Ann', last_name: 'Lee', company_name: 'Acme', website: '',
  location: 'Vancouver', operatingCities: 'Vancouver; Burnaby', country: 'CA', region: 'British Columbia', complianceLaw: BC_LAW,
}

Deno.test('createLead: sends compliance_law next to the unchanged location vars (no jurisdiction_line)', async () => {
  const f = instantlyStub()
  try {
    await createLead(KASPEN, baseLead)
    assertEquals(JSON.parse(f.calls[0].body!).custom_variables, {
      'location': 'Vancouver', 'Operating Cities Copied': 'Vancouver; Burnaby', 'compliance_law': BC_LAW,
    })
  } finally { f.restore() }
})

Deno.test('createLead: compliance_law is never blank (the generic fallback)', async () => {
  const f = instantlyStub()
  try {
    await createLead(KASPEN, { ...baseLead, location: '', operatingCities: '', complianceLaw: '' })
    await createLead('other', { ...baseLead, location: '', operatingCities: '', complianceLaw: '  ' })
    assertEquals(JSON.parse(f.calls[0].body!).custom_variables, { compliance_law: FALLBACK })
    assertEquals(JSON.parse(f.calls[1].body!).custom_variables, { compliance_law: FALLBACK })
  } finally { f.restore() }
})

Deno.test('loadActiveJurisdictions: one REST select of the active rows; a failure means no rows (fallback for all)', async () => {
  let f = stubFetch([[(u) => u.startsWith('https://db.test/rest/v1/jurisdictions?'), () => json(rows)]])
  try {
    assertEquals(await loadActiveJurisdictions(), rows)
    assertEquals(f.calls.length, 1)
    // Activation = active + a compliance_name; copy_hook is no longer read.
    assertEquals(f.calls[0].url, 'https://db.test/rest/v1/jurisdictions?active=eq.true&compliance_name=not.is.null&select=country,region,city_match,jurisdiction,compliance_name,short_name,active')
  } finally { f.restore() }
  f = stubFetch([[(u) => u.startsWith('https://db.test/rest/v1/jurisdictions?'), () => json({ message: 'boom' }, 500)]])
  const err = console.error
  console.error = () => {}
  try {
    assertEquals(await loadActiveJurisdictions(), [])
  } finally { f.restore(); console.error = err }
})

// ---- verifyFirstLead: location vars halt, compliance_law only warns ----

const listStub = (respond: () => Response) =>
  stubFetch([[(u, m) => u === 'https://api.instantly.ai/api/v2/leads/list' && m === 'POST', respond]])
const echo = (payload: Record<string, unknown>) => () => json({ items: [{ email: 'a@acme.com', payload }] })

Deno.test('verifyFirstLead: a missing location var halts, as before', async () => {
  const f = listStub(echo({ 'Operating Cities Copied': 'x', compliance_law: 'x' }))
  try {
    assertEquals(await verifyFirstLead(KASPEN, baseLead), {
      problem: 'custom variables missing on the first lead: location', warning: null,
    })
  } finally { f.restore() }
})

Deno.test('verifyFirstLead: a missing compliance_law only warns; the push continues', async () => {
  const f = listStub(echo({ location: 'x', 'Operating Cities Copied': 'x' }))
  try {
    const r = await verifyFirstLead(KASPEN, baseLead)
    assertEquals(r.problem, null)
    assertEquals(r.warning, 'compliance_law missing on the first lead (Instantly did not echo it); push continued')
  } finally { f.restore() }
})

Deno.test('verifyFirstLead: all vars echoed -> no problem, no warning', async () => {
  const f = listStub(echo({ location: 'x', 'Operating Cities Copied': 'x', compliance_law: 'x' }))
  try {
    assertEquals(await verifyFirstLead(KASPEN, baseLead), { problem: null, warning: null })
  } finally { f.restore() }
})

Deno.test('verifyFirstLead: a failed list call never blocks, as before', async () => {
  let f = listStub(() => json({ error: 'nope' }, 500))
  try {
    assertEquals(await verifyFirstLead(KASPEN, baseLead), { problem: null, warning: null })
  } finally { f.restore() }
  f = listStub(() => { throw new Error('network') })
  try {
    assertEquals(await verifyFirstLead(KASPEN, baseLead), { problem: null, warning: null })
  } finally { f.restore() }
})

// ---- processJob: routing, fallback per target, non-fatal warning recorded ----

Deno.test('processJob: a no-location lead goes to its campaign with the generic fallback law; a missing compliance_law echo is recorded, not fatal', async () => {
  const NOLOC = 'noloc-campaign'
  const pushJob = { ...job, instantly_campaign_id: KASPEN, instantly_campaign_id_nolocation: NOLOC, instantly_campaign_name_nolocation: 'NoLoc' }
  const rowNoCity = { id: 'r1', row_index: 0, email: 'a@acme.com', row_data: { 'First Name': 'Ann', 'Company Name': 'Acme', operating_city: 'UNKNOWN' } }
  let rowReads = 0
  const f = stubFetch([
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs?') && m === 'GET', () => json([pushJob])],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs?') && m === 'PATCH', () => new Response(null, { status: 204 })],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_rows?job_id=eq.j1&limit=1') && m === 'GET', () => json([rowNoCity])],
    // The route decision's paged count read (1 eligible <= threshold -> direct).
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_rows?') && u.includes('&offset=') && m === 'GET', (u) => json(u.endsWith('&offset=0') ? [rowNoCity] : [])],
    [(u) => u.startsWith('https://db.test/rest/v1/lume_settings?'), () => json([{ value: 1000 }])],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_rows?') && m === 'GET', () => json(rowReads++ === 0 ? [rowNoCity] : [])],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_rows?') && m === 'PATCH', () => new Response(null, { status: 204 })],
    [(u) => u.startsWith('https://db.test/rest/v1/jurisdictions?'), () => json([])],
    [(u) => u.startsWith('https://db.test/rest/v1/rpc/'), () => json('alert-id')],
    [(u, m) => u === 'https://api.instantly.ai/api/v2/leads' && m === 'POST', () => json({ id: 'L1' })],
    [(u) => u === 'https://api.instantly.ai/api/v2/leads/list', echo({})],
  ])
  const warn = console.warn
  const warned: unknown[] = []
  console.warn = (...a: unknown[]) => { warned.push(a) }
  try {
    await processJob('j1')
    const create = f.calls.find((c) => c.url === 'https://api.instantly.ai/api/v2/leads')!
    const body = JSON.parse(create.body!)
    assertEquals(body.campaign, NOLOC)
    assertEquals(body.custom_variables, { compliance_law: FALLBACK })
    // Not halted: the row is pushed and the job finishes.
    const rowPatch = f.calls.find((c) => c.url.startsWith('https://db.test/rest/v1/validation_rows?id=eq.r1') && c.method === 'PATCH')!
    const patched = JSON.parse(rowPatch.body!)
    assertEquals(patched.instantly_status, 'pushed')
    assertEquals(patched.instantly_result.warning, 'compliance_law missing on the first lead (Instantly did not echo it); push continued')
    const jobPatches = f.calls.filter((c) => c.url.startsWith('https://db.test/rest/v1/validation_jobs?') && c.method === 'PATCH').map((c) => JSON.parse(c.body!))
    assertEquals(jobPatches.some((p) => p.instantly_status === 'done'), true)
    assertEquals(jobPatches.some((p) => p.instantly_status === 'error'), false)
    const alertBody = f.calls.filter((c) => c.url.startsWith('https://db.test/rest/v1/rpc/')).map((c) => c.body ?? '').join('\n')
    assertEquals(alertBody.includes('compliance_law missing on the first lead'), true)
    assertEquals(warned.length > 0, true)
  } finally { f.restore(); console.warn = warn }
})

// ---- Lead bank routing ----

Deno.test('pushRoute: strictly more than the threshold banks; at or below goes direct', () => {
  assertEquals([pushRoute(1001, 1000), pushRoute(1000, 1000), pushRoute(0, 1000), pushRoute(4563, 1000)], ['bank', 'direct', 'direct', 'bank'])
})

Deno.test('loadBankThreshold: the lume_settings value, else 1000 (bad value or failed read)', async () => {
  for (const [resp, want] of [[[{ value: 2500 }], 2500], [[], 1000], [[{ value: 'x' }], 1000], [[{ value: 0 }], 1000]] as const) {
    const f = stubFetch([[(u) => u.startsWith('https://db.test/rest/v1/lume_settings?key=eq.bank_threshold'), () => json(resp)]])
    try { assertEquals(await loadBankThreshold(), want) } finally { f.restore() }
  }
  const err = console.error
  console.error = () => {}
  const f = stubFetch([[(u) => u.startsWith('https://db.test/rest/v1/lume_settings?'), () => json({ message: 'boom' }, 500)]])
  try { assertEquals(await loadBankThreshold(), 1000) } finally { f.restore(); console.error = err }
})

Deno.test('bankRow: the fields rotateLeadBody reads, lowercased email, blanks as null, law left to the rotation', () => {
  const lead = keep(decideRow(vrow({ Country: 'Canada', State: 'BC', secondary_cities: 'Burnaby' }), cols, job, ctx))
  assertEquals(bankRow({ ...lead, email: ' Ann@Acme.com ', website: '' }, KASPEN, 'j1'), {
    campaign_id: KASPEN, email: 'ann@acme.com', first_name: 'Ann', last_name: 'Lee', company_name: 'Acme Properties',
    website: null, location: 'Vancouver', operating_cities: 'Vancouver; Burnaby', country: 'CA', region: 'British Columbia',
    state: 'queued', source_job_id: 'j1',
  })
})

Deno.test('processJob: over the threshold, eligible leads are queued in lead_bank (no Instantly call), deduped, rows marked banked', async () => {
  const NOLOC = 'noloc-campaign'
  const bankJob = { ...job, instantly_campaign_id_nolocation: NOLOC, instantly_campaign_name_nolocation: 'NoLoc', instantly_banked: 0, instantly_route: null }
  const r = (id: string, email: string, extra: Record<string, unknown> = {}) =>
    ({ id, row_index: Number(id.slice(1)), email, row_data: { 'First Name': 'Ann', 'Last Name': 'Lee', 'Company Name': 'Acme LLC', operating_city: 'Vancouver', ...extra } })
  const rowsAll = [
    r('r1', 'a@acme.com'),
    r('r2', 'b@x.com', { operating_city: 'UNKNOWN' }),
    r('r3', 'c@x.com'),
    r('r4', 'A@Acme.com'),
    r('r5', 'e@x.com', { 'Company Name': 'Under Construction' }),
    r('r6', 'd@x.com'),
  ]
  let chunkReads = 0
  const f = stubFetch([
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs?') && m === 'GET', () => json([bankJob])],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs?') && m === 'PATCH', () => new Response(null, { status: 204 })],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_rows?job_id=eq.j1&limit=1') && m === 'GET', () => json([rowsAll[0]])],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_rows?') && u.includes('&offset=') && m === 'GET', (u) => json(u.endsWith('&offset=0') ? rowsAll : [])],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_rows?') && m === 'GET', () => json(chunkReads++ === 0 ? rowsAll : [])],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_rows?') && m === 'PATCH', () => new Response(null, { status: 204 })],
    [(u) => u.startsWith('https://db.test/rest/v1/lume_settings?'), () => json([{ value: 2 }])],
    [(u) => u === 'https://db.test/rest/v1/rpc/instantly_pushed_emails', () => json(['c@x.com'])],
    [(u) => u.startsWith('https://db.test/rest/v1/rpc/'), () => json('alert-id')],
    [(u, m) => u.startsWith('https://db.test/rest/v1/lead_bank?on_conflict=') && m === 'POST', (_u, body) =>
      json((JSON.parse(body!) as { campaign_id: string; email: string }[]).filter((x) => x.email !== 'd@x.com').map(({ campaign_id, email }) => ({ campaign_id, email })))],
    [(u, m) => u.startsWith('https://db.test/rest/v1/lead_bank?source_job_id=eq.j1') && m === 'GET', () => json([])],
  ])
  try {
    await processJob('j1')
    assertEquals(f.calls.some((c) => c.url.startsWith('https://api.instantly.ai')), false)
    const inserted = JSON.parse(f.calls.find((c) => c.url.startsWith('https://db.test/rest/v1/lead_bank?on_conflict='))!.body!)
    assertEquals(inserted.map((x: { email: string; campaign_id: string }) => [x.email, x.campaign_id]), [['a@acme.com', KASPEN], ['b@x.com', NOLOC], ['d@x.com', KASPEN]])
    assertEquals(inserted[1].location, null)
    assertEquals(inserted.every((x: { state: string; source_job_id: string }) => x.state === 'queued' && x.source_job_id === 'j1'), true)

    const rowPatches = f.calls.filter((c) => c.url.startsWith('https://db.test/rest/v1/validation_rows?id=in.') && c.method === 'PATCH')
      .map((c) => ({ ids: decodeURIComponent(c.url).replace(/.*in\.\(|\)$/g, '').split(','), body: JSON.parse(c.body!) }))
    const byStatus = (s: string, reason?: string) =>
      rowPatches.filter((p) => p.body.instantly_status === s && (!reason || p.body.instantly_result.reason === reason)).flatMap((p) => p.ids).sort()
    assertEquals(byStatus('banked'), ['r1', 'r2'])
    assertEquals(byStatus('filtered', 'already pushed to Instantly'), ['r3'])
    assertEquals(byStatus('filtered', 'duplicate email in this push'), ['r4'])
    assertEquals(byStatus('filtered', 'junk company name'), ['r5'])
    assertEquals(byStatus('filtered', 'already in lead bank'), ['r6'])

    const jobPatches = f.calls.filter((c) => c.url.startsWith('https://db.test/rest/v1/validation_jobs?') && c.method === 'PATCH').map((c) => JSON.parse(c.body!))
    assertEquals(jobPatches.find((p) => 'instantly_route' in p), { instantly_route: 'bank', instantly_bank_threshold: 2 })
    assertEquals(jobPatches.find((p) => 'instantly_banked' in p), { instantly_banked: 2, instantly_filtered: 4 })
    assertEquals(jobPatches.some((p) => p.instantly_status === 'done'), true)
    const alertBody = f.calls.filter((c) => c.url.startsWith('https://db.test/rest/v1/rpc/') && !c.url.endsWith('instantly_pushed_emails')).map((c) => c.body ?? '').join('\n')
    assertEquals(alertBody.includes('lead bank'), true)
  } finally { f.restore() }
})

Deno.test('processJob: at or under the threshold the route is direct, and a resumed bank push stays banked', async () => {
  // Resumed: instantly_route already 'bank' -> no count read, no threshold read, straight to the bank loop.
  const f = stubFetch([
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs?') && m === 'GET', () => json([{ ...job, instantly_route: 'bank', instantly_banked: 7 }])],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs?') && m === 'PATCH', () => new Response(null, { status: 204 })],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_rows?job_id=eq.j1&limit=1') && m === 'GET', () => json([vrow({})])],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_rows?') && m === 'GET', () => json([])],
    [(u) => u.startsWith('https://db.test/rest/v1/rpc/'), () => json('alert-id')],
  ])
  try {
    await processJob('j1')
    assertEquals(f.calls.some((c) => c.url.includes('lume_settings') || c.url.includes('&offset=') || c.url.startsWith('https://api.instantly.ai')), false)
    const jobPatches = f.calls.filter((c) => c.url.startsWith('https://db.test/rest/v1/validation_jobs?') && c.method === 'PATCH').map((c) => JSON.parse(c.body!))
    assertEquals(jobPatches.some((p) => p.instantly_status === 'done'), true)
    assertEquals(jobPatches.some((p) => 'instantly_route' in p), false)
  } finally { f.restore() }
})
