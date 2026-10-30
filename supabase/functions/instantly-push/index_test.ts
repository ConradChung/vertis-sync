// Run: deno test --allow-env instantly-push/
import { assertEquals } from 'jsr:@std/assert@1'
import { json, prepareModule, stubFetch } from '../_shared/test_fetch.ts'

prepareModule({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTANTLY_API_KEY: 'ik' })
const { createLead, decideRow, jurisdictionLineFor, loadActiveJurisdictions, processJob, verifyFirstLead } = await import('./index.ts')

const KASPEN = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
const KASPEN_FALLBACK = 'Without a GM, the owner becomes the middle manager.'
const BASE_FALLBACK = 'Most owners end up as the middle manager of their own portfolio.'
const BC_HOOK = 'In BC, a landlord notice hook.'

const job = {
  id: 'j1', filename: 'f.csv', icp_filter: false, column_order: null,
  instantly_campaign_id: KASPEN, instantly_campaign_name: 'Zenport',
  instantly_campaign_id_nolocation: null, instantly_campaign_name_nolocation: null,
  instantly_pushed_nolocation: 0, instantly_pushed: 0, instantly_filtered: 0, instantly_errors: 0,
  location_barrier: false, company_barrier: true, company_strict: false,
}
const cols = { company: 'Company Name', website: 'Website', first: 'First Name', last: 'Last Name' }
const rows = [
  { country: 'CA', region: 'British Columbia', city_match: null, jurisdiction: 'British Columbia', copy_hook: BC_HOOK, active: true },
  { country: 'US', region: 'Texas', city_match: null, jurisdiction: 'Texas', copy_hook: null, active: true },
]
const ctx = { rows, fallback: KASPEN_FALLBACK }
const vrow = (extra: Record<string, unknown>) => ({
  id: 'r1', row_index: 0, email: 'a@acme.com',
  row_data: { 'First Name': 'Ann', 'Last Name': 'Lee', 'Company Name': 'Acme Properties LLC', operating_city: 'Vancouver', ...extra },
})
// deno-lint-ignore no-explicit-any
const keep = (d: any) => { if (!d.keep) throw new Error(`dropped: ${d.reason}`); return d.lead }

Deno.test('decideRow: certain country + region -> ISO2, canonical region and the hook line', () => {
  const lead = keep(decideRow(vrow({ Country: 'Canada', State: 'BC' }), cols, job, ctx))
  assertEquals([lead.country, lead.region, lead.jurisdictionLine], ['CA', 'British Columbia', BC_HOOK])
})

Deno.test('decideRow: falls back to Company Country / Company State', () => {
  const lead = keep(decideRow(vrow({ Country: '', State: '', 'Company Country': 'Canada', 'Company State': 'British Columbia' }), cols, job, ctx))
  assertEquals([lead.country, lead.region, lead.jurisdictionLine], ['CA', 'British Columbia', BC_HOOK])
})

Deno.test('decideRow: a matching row with no hook -> the fallback sentence', () => {
  const lead = keep(decideRow(vrow({ Country: 'United States', State: 'Texas' }), cols, job, ctx))
  assertEquals([lead.country, lead.region, lead.jurisdictionLine], ['US', 'Texas', KASPEN_FALLBACK])
})

Deno.test('decideRow: uncertain country -> no country/region, fallback sentence', () => {
  for (const extra of [{}, { Country: 'Narnia', State: 'BC' }, { State: 'BC' }]) {
    const lead = keep(decideRow(vrow(extra), cols, job, ctx))
    assertEquals([lead.country, lead.region, lead.jurisdictionLine], ['', '', KASPEN_FALLBACK], JSON.stringify(extra))
  }
})

Deno.test('decideRow: region is dropped when it is not a region of that country', () => {
  const lead = keep(decideRow(vrow({ Country: 'Canada', State: 'Texas' }), cols, job, ctx))
  assertEquals([lead.country, lead.region, lead.jurisdictionLine], ['CA', '', KASPEN_FALLBACK])
})

Deno.test("decideRow: without a context (preview) the line is the job campaign's fallback", () => {
  assertEquals(keep(decideRow(vrow({ Country: 'Canada', State: 'BC' }), cols, job)).jurisdictionLine, KASPEN_FALLBACK)
  const other = { ...job, instantly_campaign_id: 'other' }
  assertEquals(keep(decideRow(vrow({}), cols, other)).jurisdictionLine, BASE_FALLBACK)
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
  location: 'Vancouver', operatingCities: 'Vancouver; Burnaby', country: 'CA', region: 'British Columbia', jurisdictionLine: BC_HOOK,
}

Deno.test('createLead: sends jurisdiction_line next to the unchanged location vars', async () => {
  const f = instantlyStub()
  try {
    await createLead(KASPEN, baseLead)
    assertEquals(JSON.parse(f.calls[0].body!).custom_variables, {
      'location': 'Vancouver', 'Operating Cities Copied': 'Vancouver; Burnaby', 'jurisdiction_line': BC_HOOK,
    })
  } finally { f.restore() }
})

Deno.test('createLead: jurisdiction_line is never blank (fallback of the target campaign)', async () => {
  const f = instantlyStub()
  try {
    await createLead(KASPEN, { ...baseLead, location: '', operatingCities: '', jurisdictionLine: '' })
    await createLead('other', { ...baseLead, location: '', operatingCities: '', jurisdictionLine: '  ' })
    assertEquals(JSON.parse(f.calls[0].body!).custom_variables, { jurisdiction_line: KASPEN_FALLBACK })
    assertEquals(JSON.parse(f.calls[1].body!).custom_variables, { jurisdiction_line: BASE_FALLBACK })
  } finally { f.restore() }
})

Deno.test('loadActiveJurisdictions: one REST select of the active rows; a failure means no rows (fallback for all)', async () => {
  let f = stubFetch([[(u) => u.startsWith('https://db.test/rest/v1/jurisdictions?'), () => json(rows)]])
  try {
    assertEquals(await loadActiveJurisdictions(), rows)
    assertEquals(f.calls.length, 1)
    assertEquals(f.calls[0].url, 'https://db.test/rest/v1/jurisdictions?active=eq.true&select=country,region,city_match,jurisdiction,copy_hook,active')
  } finally { f.restore() }
  f = stubFetch([[(u) => u.startsWith('https://db.test/rest/v1/jurisdictions?'), () => json({ message: 'boom' }, 500)]])
  const err = console.error
  console.error = () => {}
  try {
    assertEquals(await loadActiveJurisdictions(), [])
  } finally { f.restore(); console.error = err }
})

// ---- verifyFirstLead: location vars halt, jurisdiction_line only warns ----

const listStub = (respond: () => Response) =>
  stubFetch([[(u, m) => u === 'https://api.instantly.ai/api/v2/leads/list' && m === 'POST', respond]])
const echo = (payload: Record<string, unknown>) => () => json({ items: [{ email: 'a@acme.com', payload }] })

Deno.test('verifyFirstLead: a missing location var halts, as before', async () => {
  const f = listStub(echo({ 'Operating Cities Copied': 'x', jurisdiction_line: 'x' }))
  try {
    assertEquals(await verifyFirstLead(KASPEN, baseLead), {
      problem: 'custom variables missing on the first lead: location', warning: null,
    })
  } finally { f.restore() }
})

Deno.test('verifyFirstLead: a missing jurisdiction_line only warns; the push continues', async () => {
  const f = listStub(echo({ location: 'x', 'Operating Cities Copied': 'x' }))
  try {
    const r = await verifyFirstLead(KASPEN, baseLead)
    assertEquals(r.problem, null)
    assertEquals(r.warning, 'jurisdiction_line missing on the first lead (Instantly did not echo it); push continued')
  } finally { f.restore() }
})

Deno.test('verifyFirstLead: all vars echoed -> no problem, no warning', async () => {
  const f = listStub(echo({ location: 'x', 'Operating Cities Copied': 'x', jurisdiction_line: 'x' }))
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

// ---- per-target-campaign fallback ----

Deno.test("jurisdictionLineFor: a matching hook wins; otherwise the TARGET campaign's fallback", () => {
  assertEquals(jurisdictionLineFor(baseLead, 'nolocation-campaign', rows), BC_HOOK)
  const none = { ...baseLead, country: '', region: '' }
  assertEquals(jurisdictionLineFor(none, KASPEN, rows), KASPEN_FALLBACK)
  assertEquals(jurisdictionLineFor(none, 'nolocation-campaign', rows), BASE_FALLBACK)
})

// ---- processJob: routing, fallback per target, non-fatal warning recorded ----

Deno.test('processJob: a no-location lead gets its own campaign fallback; a missing jurisdiction_line echo is recorded, not fatal', async () => {
  const NOLOC = 'noloc-campaign'
  const pushJob = { ...job, instantly_campaign_id: KASPEN, instantly_campaign_id_nolocation: NOLOC, instantly_campaign_name_nolocation: 'NoLoc' }
  const rowNoCity = { id: 'r1', row_index: 0, email: 'a@acme.com', row_data: { 'First Name': 'Ann', 'Company Name': 'Acme', operating_city: 'UNKNOWN' } }
  let rowReads = 0
  const f = stubFetch([
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs?') && m === 'GET', () => json([pushJob])],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_jobs?') && m === 'PATCH', () => new Response(null, { status: 204 })],
    [(u, m) => u.startsWith('https://db.test/rest/v1/validation_rows?job_id=eq.j1&limit=1') && m === 'GET', () => json([rowNoCity])],
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
    assertEquals(body.custom_variables, { jurisdiction_line: BASE_FALLBACK })
    // Not halted: the row is pushed and the job finishes.
    const rowPatch = f.calls.find((c) => c.url.startsWith('https://db.test/rest/v1/validation_rows?id=eq.r1') && c.method === 'PATCH')!
    const patched = JSON.parse(rowPatch.body!)
    assertEquals(patched.instantly_status, 'pushed')
    assertEquals(patched.instantly_result.warning, 'jurisdiction_line missing on the first lead (Instantly did not echo it); push continued')
    const jobPatches = f.calls.filter((c) => c.url.startsWith('https://db.test/rest/v1/validation_jobs?') && c.method === 'PATCH').map((c) => JSON.parse(c.body!))
    assertEquals(jobPatches.some((p) => p.instantly_status === 'done'), true)
    assertEquals(jobPatches.some((p) => p.instantly_status === 'error'), false)
    const alertBody = f.calls.filter((c) => c.url.startsWith('https://db.test/rest/v1/rpc/')).map((c) => c.body ?? '').join('\n')
    assertEquals(alertBody.includes('jurisdiction_line missing on the first lead'), true)
    assertEquals(warned.length > 0, true)
  } finally { f.restore(); console.warn = warn }
})
