// Deterministic property-management-software detector (research P2).
//
// Pure: no network, no LLM. Input is the crawled pages (URL, text, links).
//
// Ranking, best first:
//   1. a link whose host is a known PMS portal            -> that PMS, high
//   2. a word-bounded mention of a known PMS in page text -> that PMS, medium
//   3. an external link that looks like a resident/tenant/owner portal or a
//      rent-payment page but whose host is not a known PMS -> other, medium
//   4. nothing                                            -> unknown, low
// Ties break by page order, then link / text order. Every other distinct
// value found is listed in `alternatives`.
//
// Host matching is on the parsed URL's hostname only (never path, query or
// user-info), and only as the domain itself or a subdomain of it, so
// `appfolio.com.evil.io` and `notappfolio.com` never match.

export type PmsValue = 'appfolio' | 'buildium' | 'rent_manager' | 'propertyware' | 'yardi' | 'other' | 'unknown'
export type Confidence = 'high' | 'medium' | 'low'

export interface PageLink { href: string; text?: string }
export interface Page { url: string; text: string; links: PageLink[] }

export interface PmsResult {
  value: PmsValue
  confidence: Confidence
  /** The crawled page the evidence is on; null only for unknown. */
  source_url: string | null
  /** The portal href (link evidence) or verbatim page text around the mention. */
  snippet: string | null
  /** Other distinct values found, best first. */
  alternatives: PmsValue[]
}

type KnownPms = Exclude<PmsValue, 'other' | 'unknown'>

/** Registrable domains whose host (or any subdomain) is that PMS's portal. */
const PORTAL_DOMAINS: Array<[string, KnownPms]> = [
  ['appfolio.com', 'appfolio'],
  ['managebuilding.com', 'buildium'],
  ['rentmanager.com', 'rent_manager'],
  ['propertyware.com', 'propertyware'],
  ['rentcafe.com', 'yardi'],
  ['securecafe.com', 'yardi'],
]
/** Second-level labels matched under any TLD (Rent Manager portals: *.rmportal.*). */
const PORTAL_SLDS: Array<[string, KnownPms]> = [['rmportal', 'rent_manager']]

const MENTIONS: Array<[RegExp, KnownPms]> = [
  [/\bappfolio\b/i, 'appfolio'],
  [/\bbuildium\b/i, 'buildium'],
  // Case-sensitive: "rent manager" in lower case is usually a job title.
  [/\bRent ?Manager\b|\bRENT MANAGER\b|\brentmanager\b/, 'rent_manager'],
  [/\bpropertyware\b/i, 'propertyware'],
  [/\byardi\b|\brent ?cafe\b|\bsecure ?cafe\b/i, 'yardi'],
]

const PORTAL_WORDS =
  /\b(resident|tenant|owner|renter)s?['’]?\s*(portal|login|log in|sign in|center|centre)\b|\bpay\s+(my\s+|your\s+)?rent\b|\brent\s+payment|\bportal\b/i

const SNIPPET_RADIUS = 80

function hostOf(href: string, base?: string): string | null {
  let u: URL
  try {
    u = base ? new URL(href, base) : new URL(href)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  return host || null
}

function onDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain)
}

/** The known PMS a URL's host belongs to, or null. */
export function classifyPortalHost(href: string, base?: string): KnownPms | null {
  const host = hostOf(href, base)
  if (!host) return null
  for (const [domain, pms] of PORTAL_DOMAINS) if (onDomain(host, domain)) return pms
  const labels = host.split('.')
  if (labels.length >= 2) {
    const sld = labels[labels.length - 2]
    for (const [label, pms] of PORTAL_SLDS) if (sld === label) return pms
  }
  return null
}

/** Host without a leading www., for same-site checks. */
function siteOf(host: string): string {
  return host.replace(/^www\./, '')
}

function sameSite(a: string, b: string): boolean {
  const x = siteOf(a)
  const y = siteOf(b)
  return x === y || x.endsWith('.' + y) || y.endsWith('.' + x)
}

/** Verbatim slice of `text` around [start, end), widened to word boundaries. */
function snippetAround(text: string, start: number, end: number): string {
  let s = Math.max(0, start - SNIPPET_RADIUS)
  let e = Math.min(text.length, end + SNIPPET_RADIUS)
  if (s > 0) {
    const sp = text.indexOf(' ', s)
    if (sp !== -1 && sp < start) s = sp + 1
  }
  if (e < text.length) {
    const sp = text.lastIndexOf(' ', e)
    if (sp >= end) e = sp
  }
  return text.slice(s, e).trim()
}

interface Candidate { value: PmsValue; confidence: Confidence; source_url: string; snippet: string; rank: number }

export function detectPms(pages: Page[]): PmsResult {
  const found: Candidate[] = []

  for (const page of pages) {
    const pageHost = hostOf(page.url)
    for (const link of page.links ?? []) {
      const pms = classifyPortalHost(link.href, page.url)
      if (pms) {
        found.push({ value: pms, confidence: 'high', source_url: page.url, snippet: link.href, rank: 0 })
        continue
      }
      const host = hostOf(link.href, page.url)
      if (!host || !pageHost || sameSite(host, pageHost)) continue
      let path = ''
      try {
        path = decodeURIComponent(new URL(link.href, page.url).pathname)
      } catch { /* keep empty */ }
      const words = `${link.text ?? ''} ${host} ${path.replace(/[-_/]+/g, ' ')}`
      if (PORTAL_WORDS.test(words)) {
        found.push({ value: 'other', confidence: 'medium', source_url: page.url, snippet: link.href, rank: 2 })
      }
    }
  }

  for (const page of pages) {
    const text = page.text ?? ''
    const hits: Array<{ index: number; end: number; pms: KnownPms }> = []
    for (const [re, pms] of MENTIONS) {
      const m = re.exec(text)
      if (m) hits.push({ index: m.index, end: m.index + m[0].length, pms })
    }
    hits.sort((a, b) => a.index - b.index)
    for (const h of hits) {
      found.push({
        value: h.pms,
        confidence: 'medium',
        source_url: page.url,
        snippet: snippetAround(text, h.index, h.end),
        rank: 1,
      })
    }
  }

  if (!found.length) return { value: 'unknown', confidence: 'low', source_url: null, snippet: null, alternatives: [] }

  // Stable sort keeps page / link order inside each rank.
  const ordered = found.map((c, i) => ({ c, i })).sort((a, b) => a.c.rank - b.c.rank || a.i - b.i).map((x) => x.c)
  const best = ordered[0]
  const alternatives: PmsValue[] = []
  for (const c of ordered) if (c.value !== best.value && !alternatives.includes(c.value)) alternatives.push(c.value)
  return { value: best.value, confidence: best.confidence, source_url: best.source_url, snippet: best.snippet, alternatives }
}
