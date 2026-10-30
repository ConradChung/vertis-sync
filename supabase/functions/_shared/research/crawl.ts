// Crawl helpers for company-research (research P2). Pure.
//
// Actor: apify/website-content-crawler (id aYG0l9s7dbB7j3gbS), pricing model
// FREE = pay per platform usage (compute units), checked 2026-10-29 against
// GET /v2/acts/apify~website-content-crawler and its version-0 build's input
// schema. Cheerio (raw HTTP) mode, at most 8 pages: the home page plus links
// from it (depth 1) whose URL mentions about / contact / careers / jobs /
// residents / tenants / portal / login.
//
// Cost: pay-per-usage, so the run is bounded by memory x timeout. At 1 GB for
// at most 180 s and the worst compute-unit price ($0.40/CU, as in
// lume/lib/apify/pricing.ts) one crawl costs at most 1 x 0.05 h x 0.40 =
// $0.02. That worst case is the estimate the budget gate reserves; the run's
// actual `usageTotalUsd` replaces it afterwards (typically well under a cent).

import type { Page, PageLink } from './pms.ts'

export const CRAWL_ACTOR_ID = 'apify~website-content-crawler'
export const CRAWL_MAX_PAGES = 8
export const CRAWL_MEMORY_MB = 1024
export const CRAWL_TIMEOUT_SECS = 180
/** Worst-case compute-unit price (Apify's highest list price); same as lume/lib/apify/pricing.ts. */
export const CU_USD_MAX = 0.4
export const DEFAULT_CAP_USD = 29

const PAGE_KEYWORDS = ['about', 'contact', 'career', 'job', 'employment', 'resident', 'tenant', 'portal', 'login']
const MAX_TEXT_CHARS = 40_000
/** Only this much of a page's html goes through the link regex (bounds CPU on huge pages; portal links sit in the header). */
export const MAX_HTML_BYTES = 200_000
const MAX_LINKS = 400

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const PRIVATE_TLDS = new Set(['local', 'localhost', 'internal', 'lan', 'home', 'test', 'invalid', 'corp', 'intranet'])

export type Target = { domain: string; startUrl: string } | { error: string }

/** `{domain}` or `{url}` -> the normalized domain (lowercase, no www.) and the https start URL. */
export function normalizeTarget(input: { domain?: unknown; url?: unknown }): Target {
  const raw = typeof input.url === 'string' && input.url.trim()
    ? input.url.trim()
    : typeof input.domain === 'string' ? input.domain.trim() : ''
  if (!raw) return { error: 'domain_or_url_required' }
  if (raw.length > 2000 || /\s/.test(raw)) return { error: 'bad_domain' }
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { error: 'bad_domain' }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'bad_domain' }
  if (u.username || u.password || u.port) return { error: 'bad_domain' }
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  const domain = host.replace(/^www\./, '')
  if (domain.length > 253 || !DOMAIN_RE.test(domain)) return { error: 'bad_domain' }
  if (/^[\d.]+$/.test(domain)) return { error: 'bad_domain' }
  if (PRIVATE_TLDS.has(domain.split('.').pop()!)) return { error: 'bad_domain' }
  return { domain, startUrl: `${u.protocol}//${host}/` }
}

/** Website Content Crawler input (field names per its input schema). */
export function buildCrawlInput(startUrl: string, domain: string): Record<string, unknown> {
  const base = `http{s,}://{www.,}${domain}`
  const includeUrlGlobs = PAGE_KEYWORDS.flatMap((kw) => [
    { glob: `${base}/**/*${kw}*` },
    { glob: `${base}/**/*${kw}*/**` },
  ])
  return {
    startUrls: [{ url: startUrl }],
    crawlerType: 'cheerio',
    includeUrlGlobs,
    excludeUrlGlobs: [{ glob: `${base}/**/*.{pdf,jpg,jpeg,png,gif,webp,svg,zip,doc,docx,xls,xlsx}` }],
    maxCrawlDepth: 1,
    maxCrawlPages: CRAWL_MAX_PAGES,
    maxResults: CRAWL_MAX_PAGES,
    useSitemaps: false,
    respectRobotsTxtFile: true,
    maxRequestRetries: 1,
    requestTimeoutSecs: 30,
    // Keep nav / header / footer: resident-portal and login links live there.
    removeElementsCssSelector: "script, style, noscript, svg, img[src^='data:']",
    htmlTransformer: 'none',
    removeCookieWarnings: true,
    saveMarkdown: true,
    saveHtml: true,
    saveFiles: false,
    saveScreenshots: false,
    proxyConfiguration: { useApifyProxy: true },
  }
}

/** Worst-case USD for one crawl: memory GB x timeout hours x worst CU price, rounded up to the cent. */
export function crawlEstimateUsd(): number {
  const raw = (CRAWL_MEMORY_MB / 1024) * (CRAWL_TIMEOUT_SECS / 3600) * CU_USD_MAX
  return Math.ceil(raw * 100 - 1e-9) / 100
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' }
function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, e: string) => ENTITIES[e])
}

export function linksFromHtml(html: string): PageLink[] {
  const out: PageLink[] = []
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && out.length < MAX_LINKS) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1])
    const value = href ? (href[1] ?? href[2] ?? href[3] ?? '').trim() : ''
    if (!value) continue
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
    out.push({ href: decodeEntities(value), text })
  }
  return out
}

export function linksFromMarkdown(md: string): PageLink[] {
  const out: PageLink[] = []
  // Image links nest: [![alt](img)](href). Take inner [alt](img) and outer (href) both.
  const re = /\[([^\]\[]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) && out.length < MAX_LINKS) out.push({ href: m[2], text: m[1].trim() })
  const outer = /\]\(\s*[^)]*\)\]\(\s*<?([^)\s>]+)>?\s*\)/g
  while ((m = outer.exec(md)) && out.length < MAX_LINKS) out.push({ href: m[1], text: '' })
  return out
}

type Raw = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Dataset items -> at most 8 pages with URL, text and links (html links first, then markdown, deduped by href). */
export function pagesFromItems(items: unknown[]): Page[] {
  const pages: Page[] = []
  const seen = new Set<string>()
  for (const it of items) {
    if (pages.length >= CRAWL_MAX_PAGES) break
    if (!it || typeof it !== 'object') continue
    const item = it as Raw
    const crawl = (item.crawl && typeof item.crawl === 'object' ? item.crawl : {}) as Raw
    const url = str(item.url) || str(crawl.loadedUrl)
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    const text = (str(item.text) || str(item.markdown)).slice(0, MAX_TEXT_CHARS)
    if (!text.trim()) continue
    const links: PageLink[] = []
    const hrefs = new Set<string>()
    const html = str(item.html).slice(0, MAX_HTML_BYTES)
    for (const l of [...linksFromHtml(html), ...linksFromMarkdown(str(item.markdown).slice(0, MAX_HTML_BYTES))]) {
      if (hrefs.has(l.href) || links.length >= MAX_LINKS) continue
      hrefs.add(l.href)
      links.push(l)
    }
    seen.add(url)
    pages.push({ url, text, links })
  }
  return pages
}

/** GET /v2/users/me/usage/monthly -> USD used this usage cycle, or null when unreadable. */
export function parseMonthlyUsage(body: unknown): number | null {
  const data = body && typeof body === 'object' ? (body as Raw).data : null
  if (!data || typeof data !== 'object') return null
  for (const k of ['totalUsageCreditsUsdAfterVolumeDiscount', 'totalUsageCreditsUsdBeforeVolumeDiscount']) {
    const v = (data as Raw)[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return null
}

export function parseCap(raw: string | undefined): number {
  const n = Number((raw ?? '').trim())
  return raw && raw.trim() && Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP_USD
}
