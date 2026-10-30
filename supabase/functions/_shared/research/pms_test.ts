import { assertEquals } from 'jsr:@std/assert@1'
import { classifyPortalHost, detectPms, type Page } from './pms.ts'

const page = (url: string, text: string, links: Array<string | { href: string; text?: string }> = []): Page => ({
  url,
  text,
  links: links.map((l) => (typeof l === 'string' ? { href: l } : l)),
})

// --- host classification ----------------------------------------------------

Deno.test('classifyPortalHost: each known portal host, apex and subdomain', () => {
  const cases: Array<[string, string]> = [
    ['https://acme.appfolio.com/connect', 'appfolio'],
    ['https://appfolio.com/', 'appfolio'],
    ['https://acme.managebuilding.com/Resident/portal/login', 'buildium'],
    ['https://managebuilding.com', 'buildium'],
    ['https://acme.rentmanager.com/', 'rent_manager'],
    ['https://rentmanager.com', 'rent_manager'],
    ['https://acme.rmportal.com/', 'rent_manager'],
    ['https://acme.rmportal.net/login', 'rent_manager'],
    ['https://app.propertyware.com/pw/portals/acme/tenant.action', 'propertyware'],
    ['https://acme.rentcafe.com/residentservices/acme/userlogin.aspx', 'yardi'],
    ['https://www.securecafe.com/residentservices/acme/userlogin.aspx', 'yardi'],
    ['https://ACME.AppFolio.COM./connect', 'appfolio'],
  ]
  for (const [url, want] of cases) assertEquals(classifyPortalHost(url), want, url)
})

Deno.test('classifyPortalHost: look-alike hosts never match', () => {
  for (const url of [
    'https://appfolio.com.evil.io/connect',
    'https://notappfolio.com/',
    'https://appfolio-login.com/',
    'https://evil.io/acme.appfolio.com',
    'https://evil.io/?next=https://acme.appfolio.com',
    'https://acme.appfolio.com@evil.io/',
    'https://managebuilding.com.evil.io/',
    'https://fakemanagebuilding.com/',
    'https://rmportal.evil.io/',
    'https://acme.rmportal.com.evil.io/',
    'https://myrentmanager.com/',
    'https://propertyware.co/',
    'https://rentcafe.com.phish.net/',
    'https://securecafe-login.com/',
    'mailto:help@appfolio.com',
    'javascript:alert(1)',
    'not a url',
  ]) {
    assertEquals(classifyPortalHost(url), null, url)
  }
})

// --- detectPms ----------------------------------------------------------------

Deno.test('detectPms: a portal link is high, with the page URL as source and the href as snippet', () => {
  const r = detectPms([
    page('https://acme-pm.com/', 'Welcome to Acme', [{ href: 'https://acme.appfolio.com/connect', text: 'Resident Login' }]),
  ])
  assertEquals(r.value, 'appfolio')
  assertEquals(r.confidence, 'high')
  assertEquals(r.source_url, 'https://acme-pm.com/')
  assertEquals(r.snippet, 'https://acme.appfolio.com/connect')
})

Deno.test('detectPms: true positive per PMS (link)', () => {
  const cases: Array<[string, string]> = [
    ['https://acme.appfolio.com/connect', 'appfolio'],
    ['https://acme.managebuilding.com/Resident/portal/login', 'buildium'],
    ['https://acme.rmportal.com/', 'rent_manager'],
    ['https://acme.rentmanager.com/', 'rent_manager'],
    ['https://app.propertyware.com/pw/portals/acme/tenant.action', 'propertyware'],
    ['https://acme.rentcafe.com/residentservices/', 'yardi'],
    ['https://www.securecafe.com/residentservices/acme/', 'yardi'],
  ]
  for (const [href, want] of cases) {
    const r = detectPms([page('https://acme-pm.com/', 'Hi', [href])])
    assertEquals([r.value, r.confidence], [want, 'high'], href)
  }
})

Deno.test('detectPms: relative links resolve against the page and never match a portal', () => {
  const r = detectPms([page('https://acme-pm.com/residents', 'Residents', ['/appfolio.com/login', 'portal'])])
  assertEquals(r.value, 'unknown')
})

Deno.test('detectPms: look-alike links do not match (and are not treated as known PMS)', () => {
  const r = detectPms([
    page('https://acme-pm.com/', 'Welcome', ['https://appfolio.com.evil.io/connect', 'https://notappfolio.com/']),
  ])
  assertEquals(r.value, 'unknown')
  assertEquals(r.confidence, 'low')
  assertEquals(r.source_url, null)
})

Deno.test('detectPms: a mention without a link is medium, snippet is verbatim page text around it', () => {
  const text = 'Our team uses   Buildium to process maintenance requests quickly for every owner.'
  const r = detectPms([page('https://acme-pm.com/about', text)])
  assertEquals(r.value, 'buildium')
  assertEquals(r.confidence, 'medium')
  assertEquals(r.source_url, 'https://acme-pm.com/about')
  assertEquals(text.includes(r.snippet!), true)
  assertEquals(r.snippet!.includes('Buildium'), true)
})

Deno.test('detectPms: text mentions per PMS', () => {
  const cases: Array<[string, string]> = [
    ['Pay rent online through AppFolio.', 'appfolio'],
    ['We use Rent Manager for accounting.', 'rent_manager'],
    ['Log in to Propertyware to view statements.', 'propertyware'],
    ['Apply on RENTCafe today.', 'yardi'],
    ['Powered by Yardi Breeze.', 'yardi'],
  ]
  for (const [text, want] of cases) {
    const r = detectPms([page('https://acme-pm.com/', text)])
    assertEquals([r.value, r.confidence], [want, 'medium'], text)
  }
})

Deno.test('detectPms: words that merely contain a PMS name are not mentions', () => {
  for (const text of ['visit notappfolio today', 'the appfolios archive', 'ask your rent manager', 'yardibird']) {
    assertEquals(detectPms([page('https://acme-pm.com/', text)]).value, 'unknown', text)
  }
})

Deno.test('detectPms: a link beats a mention, even when the mention comes first', () => {
  const r = detectPms([
    page('https://acme-pm.com/', 'We migrated from Buildium last year.'),
    page('https://acme-pm.com/residents', 'Residents', ['https://acme.appfolio.com/connect']),
  ])
  assertEquals([r.value, r.confidence, r.source_url], ['appfolio', 'high', 'https://acme-pm.com/residents'])
  assertEquals(r.alternatives, ['buildium'])
})

Deno.test('detectPms: two portal links — the first in page order wins, the other is listed', () => {
  const r = detectPms([
    page('https://acme-pm.com/', 'Hi', ['https://acme.rentcafe.com/residentservices/']),
    page('https://acme-pm.com/owners', 'Owners', ['https://acme.appfolio.com/oportal']),
  ])
  assertEquals([r.value, r.confidence], ['yardi', 'high'])
  assertEquals(r.alternatives, ['appfolio'])
})

Deno.test('detectPms: an unrecognized external portal link is other', () => {
  const r = detectPms([
    page('https://acme-pm.com/', 'Hi', [
      { href: 'https://acme-pm.com/about', text: 'About' },
      { href: 'https://portal.someotherpms.io/acme', text: 'Resident Portal' },
    ]),
  ])
  assertEquals([r.value, r.confidence, r.snippet], ['other', 'medium', 'https://portal.someotherpms.io/acme'])
})

Deno.test('detectPms: a same-site portal page is not an unrecognized portal', () => {
  const r = detectPms([page('https://acme-pm.com/', 'Hi', [{ href: 'https://www.acme-pm.com/resident-portal', text: 'Resident Portal' }])])
  assertEquals(r.value, 'unknown')
})

Deno.test('detectPms: a known PMS mention outranks an unrecognized portal link', () => {
  const r = detectPms([
    page('https://acme-pm.com/', 'Owners log in with Propertyware.', [{ href: 'https://pay.example-pay.com/acme', text: 'Pay Rent' }]),
  ])
  assertEquals([r.value, r.confidence], ['propertyware', 'medium'])
  assertEquals(r.alternatives, ['other'])
})

Deno.test('detectPms: nothing found is unknown with no source', () => {
  assertEquals(detectPms([page('https://acme-pm.com/', 'We manage homes.')]), {
    value: 'unknown',
    confidence: 'low',
    source_url: null,
    snippet: null,
    alternatives: [],
  })
  assertEquals(detectPms([]).value, 'unknown')
})

Deno.test('detectPms: deterministic for the same input', () => {
  const pages = [page('https://acme-pm.com/', 'AppFolio and Buildium', ['https://acme.managebuilding.com/'])]
  assertEquals(detectPms(pages), detectPms(pages))
})
