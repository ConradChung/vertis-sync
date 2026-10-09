import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  APOLLO_MAX_ORGS,
  assignRole,
  buildApolloUrl,
  headerIndex,
  isGtmTitle,
  mapLeadsfridayRow,
  normalizeCompanyName,
  normalizeDomain,
  parseCsv,
  rankContacts,
  rowToRecord,
  sameSheetDate,
  toCsv,
} from './pure.ts'

Deno.test('isGtmTitle accepts the GTM-engineer family', () => {
  for (const t of [
    'Founding GTM Engineer',
    'Go-To-Market Engineer',
    'Go to Market Engineer',
    'Growth Engineer',
    'Revenue Engineer',
    'GTM Ops Lead',
    'Head of GTM Systems',
    'RevOps Engineer',
    'Sales Systems Engineer',
    'Sales Automation Engineer',
    'Forward Deployed Growth Engineer',
    'gtm engineer (remote)',
  ]) assert(isGtmTitle(t), `expected match: ${t}`)
})

Deno.test('isGtmTitle rejects unrelated titles', () => {
  for (const t of ['Account Executive', 'Software Engineer', 'Growth Marketing Manager', 'Sales Development Representative', ''])
    assert(!isGtmTitle(t), `expected no match: ${t}`)
})

Deno.test('normalizeCompanyName strips punctuation and corporate suffixes', () => {
  assertEquals(normalizeCompanyName('The Trunk Tools, Inc.'), 'trunk tools')
  assertEquals(normalizeCompanyName('Peec AI'), 'peec ai')
  assertEquals(normalizeCompanyName('DepthFirst LLC'), 'depthfirst')
  assertEquals(normalizeCompanyName('  Acme   Corp  '), 'acme')
  assertEquals(normalizeCompanyName('Co-Pilot Co.'), 'co pilot')
  assertEquals(normalizeCompanyName(''), '')
})

Deno.test('normalizeDomain strips scheme, www, path and query', () => {
  assertEquals(normalizeDomain('https://www.trunktools.com/careers?x=1'), 'trunktools.com')
  assertEquals(normalizeDomain('http://peec.ai'), 'peec.ai')
  assertEquals(normalizeDomain('DepthFirst.com/'), 'depthfirst.com')
  assertEquals(normalizeDomain('www.example.co.uk#top'), 'example.co.uk')
  assertEquals(normalizeDomain(''), '')
  assertEquals(normalizeDomain('   '), '')
})

Deno.test('headerIndex finds a column by name, case-insensitively, or throws naming it', () => {
  const headers = ['companyName', 'title', ' added_on ']
  assertEquals(headerIndex(headers, 'title'), 1)
  assertEquals(headerIndex(headers, 'companyname'), 0)
  assertEquals(headerIndex(headers, 'added_on'), 2)
  const err = assertThrows(() => headerIndex(headers, 'status'), Error)
  assert(err.message.includes('status'))
})

Deno.test('rowToRecord pads short rows', () => {
  assertEquals(rowToRecord(['a', 'b', 'c'], ['1']), { a: '1', b: '', c: '' })
})

Deno.test('parseCsv handles quoted commas, doubled quotes, CRLF and quoted newlines', () => {
  const csv = 'a,b\r\n"x, y",2\r\n"say ""hi""","line1\nline2"\r\n'
  const { headers, rows } = parseCsv(csv)
  assertEquals(headers, ['a', 'b'])
  assertEquals(rows, [['x, y', '2'], ['say "hi"', 'line1\nline2']])
})

Deno.test('parseCsv skips blank lines and tolerates a missing trailing newline', () => {
  const { headers, rows } = parseCsv('h1,h2\n\n1,2\n3,4')
  assertEquals(headers, ['h1', 'h2'])
  assertEquals(rows, [['1', '2'], ['3', '4']])
})

Deno.test('assignRole: job poster name wins over every title', () => {
  assertEquals(assignRole('Software Engineer', 'Jane', 'Doe', 'jane doe'), 'job_poster')
  assertEquals(assignRole('CRO', 'Jane', 'Doe', 'Jane  Doe'), 'job_poster')
})

Deno.test('assignRole: title buckets in priority order', () => {
  assertEquals(assignRole('Head of Talent', 'A', 'B', null), 'recruiter')
  assertEquals(assignRole('Technical Recruiter', 'A', 'B', null), 'recruiter')
  assertEquals(assignRole('Head of People', 'A', 'B', null), 'recruiter')
  assertEquals(assignRole('CRO', 'A', 'B', null), 'sales_leader')
  assertEquals(assignRole('Chief Revenue Officer', 'A', 'B', null), 'sales_leader')
  assertEquals(assignRole('VP Sales', 'A', 'B', null), 'sales_leader')
  assertEquals(assignRole('VP of Growth', 'A', 'B', null), 'sales_leader')
  assertEquals(assignRole('Head of GTM', 'A', 'B', null), 'sales_leader')
  assertEquals(assignRole('Director of Sales', 'A', 'B', null), 'sales_leader')
  assertEquals(assignRole('Co-Founder & CEO', 'A', 'B', null), 'founder')
  assertEquals(assignRole('Chief Executive Officer', 'A', 'B', null), 'founder')
  // recruiter beats founder when both words appear; sales beats founder too.
  assertEquals(assignRole('Co-Founder & CRO', 'A', 'B', null), 'sales_leader')
  assertEquals(assignRole('Software Engineer', 'A', 'B', null), 'other')
  assertEquals(assignRole('Macro Analyst', 'A', 'B', null), 'other') // "cro" inside a word is not CRO
  assertEquals(assignRole('', 'A', 'B', null), 'other')
})

Deno.test('rankContacts orders by role, then email, then seniority and keeps the top N', () => {
  const input = [
    { id: 'founder-noemail', role: 'founder' as const, email: null, seniority: 'founder' },
    { id: 'other', role: 'other' as const, email: 'o@x.com', seniority: 'manager' },
    { id: 'founder-email', role: 'founder' as const, email: 'f@x.com', seniority: 'founder' },
    { id: 'sales-dir', role: 'sales_leader' as const, email: 's@x.com', seniority: 'director' },
    { id: 'sales-vp', role: 'sales_leader' as const, email: 'v@x.com', seniority: 'vp' },
    { id: 'recruiter', role: 'recruiter' as const, email: 'r@x.com', seniority: 'manager' },
    { id: 'other2', role: 'other' as const, email: null, seniority: 'entry' },
  ]
  const ranked = rankContacts(input, 5)
  assertEquals(ranked.map(r => r.id), ['recruiter', 'sales-vp', 'sales-dir', 'founder-email', 'founder-noemail', 'other', 'other2'])
  assertEquals(ranked.map(r => r.rank), [1, 2, 3, 4, 5, 6, 7])
  assertEquals(ranked.map(r => r.kept), [true, true, true, true, true, false, false])
})

Deno.test('buildApolloUrl encodes brackets, lists every org id and the fixed filters', () => {
  const url = buildApolloUrl(['a1', 'b2'])
  assert(url.startsWith('https://app.apollo.io/#/people?sortAscending=false&sortByField=%5Bnone%5D&page=1'))
  assert(url.includes('&organizationIds%5B%5D=a1&organizationIds%5B%5D=b2'))
  for (const s of ['owner', 'founder', 'c_suite', 'vp', 'head', 'director', 'manager'])
    assert(url.includes(`personSeniorities%5B%5D=${s}`), s)
  for (const d of ['c_suite', 'master_sales', 'master_human_resources', 'master_operations'])
    assert(url.includes(`personDepartmentOrSubdepartments%5B%5D=${d}`), d)
  assert(!url.includes('['))
})

Deno.test('buildApolloUrl refuses empty input and more than the cap', () => {
  assertThrows(() => buildApolloUrl([]))
  assertThrows(() => buildApolloUrl(Array.from({ length: APOLLO_MAX_ORGS + 1 }, (_, i) => `o${i}`)))
  buildApolloUrl(Array.from({ length: APOLLO_MAX_ORGS }, (_, i) => `o${i}`)) // exactly the cap is fine
})

Deno.test('mapLeadsfridayRow maps Apollo-style export headers', () => {
  const record = {
    'First Name': 'Ada', 'Last Name': 'Lovelace', 'Title': 'CRO', 'Email': 'ada@peec.ai',
    'Person Linkedin Url': 'https://linkedin.com/in/ada', 'Company': 'Peec AI', 'Website': 'https://www.peec.ai',
    'Seniority': 'C suite', 'Departments': 'Master Sales', 'City': 'Berlin', 'State': '', 'Country': 'Germany',
    'Corporate Phone': '+49 30 1234',
  }
  const c = mapLeadsfridayRow(record)
  assertEquals(c, {
    first_name: 'Ada', last_name: 'Lovelace', title: 'CRO', email: 'ada@peec.ai',
    linkedin_url: 'https://linkedin.com/in/ada', company_name: 'Peec AI', website: 'https://www.peec.ai',
    seniority: 'C suite', department: 'Master Sales', location: 'Berlin, Germany', corporate_phone: '+49 30 1234',
  })
})

Deno.test('mapLeadsfridayRow tolerates snake_case headers and blanks email to null', () => {
  const c = mapLeadsfridayRow({ first_name: 'B', last_name: 'C', job_title: 'Founder', email: '  ', company_name: 'X', linkedin_url: '' })
  assertEquals(c.email, null)
  assertEquals(c.linkedin_url, null)
  assertEquals(c.title, 'Founder')
  assertEquals(c.company_name, 'X')
  assertEquals(c.location, null)
})

Deno.test('toCsv quotes what needs quoting', () => {
  assertEquals(toCsv(['a', 'b'], [['x, y', 'say "hi"'], ['plain', '']]), 'a,b\r\n"x, y","say ""hi"""\r\nplain,\r\n')
})

Deno.test('sameSheetDate matches ISO strings, serials and parseable dates', () => {
  assert(sameSheetDate('2026-10-12', '2026-10-12'))
  assert(sameSheetDate(' 2026-10-12 ', '2026-10-12'))
  assert(sameSheetDate('2026-10-12T00:00:00', '2026-10-12'))
  assert(sameSheetDate(46307, '2026-10-12')) // Sheets serial for 2026-10-12
  assert(sameSheetDate('46307', '2026-10-12'))
  assert(!sameSheetDate('2026-10-05', '2026-10-12'))
  assert(!sameSheetDate('', '2026-10-12'))
  assert(!sameSheetDate(null, '2026-10-12'))
  assert(!sameSheetDate('not a date', '2026-10-12'))
})
