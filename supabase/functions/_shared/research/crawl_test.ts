import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  buildCrawlInput,
  CRAWL_MAX_PAGES,
  CRAWL_MEMORY_MB,
  CRAWL_TIMEOUT_SECS,
  crawlEstimateUsd,
  linksFromHtml,
  linksFromMarkdown,
  MAX_HTML_BYTES,
  normalizeTarget,
  pagesFromItems,
  parseCap,
  parseMonthlyUsage,
} from './crawl.ts'

Deno.test('normalizeTarget: domain or url -> normalized domain + https start URL', () => {
  assertEquals(normalizeTarget({ domain: 'Acme-PM.com' }), { domain: 'acme-pm.com', startUrl: 'https://acme-pm.com/' })
  assertEquals(normalizeTarget({ domain: 'www.acme-pm.com.' }), { domain: 'acme-pm.com', startUrl: 'https://www.acme-pm.com/' })
  assertEquals(normalizeTarget({ url: 'https://www.Acme-PM.com/about?x=1#y' }), { domain: 'acme-pm.com', startUrl: 'https://www.acme-pm.com/' })
  assertEquals(normalizeTarget({ url: 'http://acme-pm.co.uk/contact' }), { domain: 'acme-pm.co.uk', startUrl: 'http://acme-pm.co.uk/' })
  assertEquals(normalizeTarget({ url: 'acme-pm.com/about' }), { domain: 'acme-pm.com', startUrl: 'https://acme-pm.com/' })
})

Deno.test('normalizeTarget: refuses what is not a public web domain', () => {
  for (const t of [
    {}, { domain: '' }, { domain: 'localhost' }, { url: 'ftp://acme.com' }, { url: 'https://127.0.0.1/' },
    { url: 'https://[::1]/' }, { domain: 'acme .com' }, { url: 'https://user:pw@acme.com/' }, { url: 'https://acme.com:8443/' },
    { domain: 'a'.repeat(260) + '.com' }, { domain: 42 as unknown as string }, { domain: 'acme.internal' },
  ]) {
    const r = normalizeTarget(t as { domain?: string; url?: string })
    assert('error' in r, JSON.stringify(t))
  }
})

Deno.test('buildCrawlInput: cheerio, <= 8 pages, depth 1, only the keyword pages, keeps nav/footer links', () => {
  const input = buildCrawlInput('https://www.acme-pm.com/', 'acme-pm.com')
  assertEquals(input.crawlerType, 'cheerio')
  assertEquals(input.startUrls, [{ url: 'https://www.acme-pm.com/' }])
  assertEquals(input.maxCrawlPages, CRAWL_MAX_PAGES)
  assertEquals(input.maxResults, CRAWL_MAX_PAGES)
  assertEquals(CRAWL_MAX_PAGES, 8)
  assertEquals(input.maxCrawlDepth, 1)
  assertEquals(input.useSitemaps, false)
  assertEquals(input.saveHtml, true)
  assertEquals(input.saveMarkdown, true)
  assertEquals(input.htmlTransformer, 'none')
  assertEquals(input.proxyConfiguration, { useApifyProxy: true })
  // nav / footer are where resident-portal links live: they must not be stripped.
  assert(!/\bnav\b|\bfooter\b/.test(String(input.removeElementsCssSelector)))
  const globs = (input.includeUrlGlobs as Array<{ glob: string }>).map((g) => g.glob)
  for (const kw of ['about', 'contact', 'career', 'job', 'resident', 'tenant', 'portal']) {
    assert(globs.some((g) => g.includes(`*${kw}*`) && g.includes('acme-pm.com')), kw)
  }
  assert(globs.every((g) => g.startsWith('http{s,}://{www.,}acme-pm.com/')))
})

Deno.test('crawlEstimateUsd: worst case at the highest compute-unit price, about 2 cents', () => {
  assertEquals(CRAWL_MEMORY_MB, 1024)
  assertEquals(CRAWL_TIMEOUT_SECS, 180)
  assertEquals(crawlEstimateUsd(), 0.02)
})

Deno.test('linksFromHtml: href + anchor text, entities decoded, scripts ignored', () => {
  const html = `<nav><a class="btn" href="https://acme.appfolio.com/connect">Resident <b>Login</b></a>
    <a href='/about-us'>About</a><a href="mailto:x@y.com">Mail</a><a name="x">no href</a>
    <a href="https://pay.example.com/?a=1&amp;b=2">Pay Rent</a></nav>`
  assertEquals(linksFromHtml(html), [
    { href: 'https://acme.appfolio.com/connect', text: 'Resident Login' },
    { href: '/about-us', text: 'About' },
    { href: 'mailto:x@y.com', text: 'Mail' },
    { href: 'https://pay.example.com/?a=1&b=2', text: 'Pay Rent' },
  ])
})

Deno.test('linksFromMarkdown: [text](href) incl. image links', () => {
  assertEquals(linksFromMarkdown('See [Resident Portal](https://acme.rentcafe.com/r) and [![logo](/l.png)](https://acme-pm.com/)'), [
    { href: 'https://acme.rentcafe.com/r', text: 'Resident Portal' },
    { href: '/l.png', text: 'logo' },
    { href: 'https://acme-pm.com/', text: '' },
  ])
})

Deno.test('pagesFromItems: url, text, merged links; capped at 8 pages; empty pages skipped', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    url: `https://acme-pm.com/p${i}`,
    text: `page ${i}`,
    markdown: `[A](https://a.com/${i})`,
    html: `<a href="https://a.com/${i}">A</a><a href="https://b.com/">B</a>`,
  }))
  items.splice(1, 0, { url: 'https://acme-pm.com/empty', text: '', markdown: '', html: '' })
  const pages = pagesFromItems(items)
  assertEquals(pages.length, 8)
  assertEquals(pages[0], {
    url: 'https://acme-pm.com/p0',
    text: 'page 0',
    links: [{ href: 'https://a.com/0', text: 'A' }, { href: 'https://b.com/', text: 'B' }],
  })
  assert(!pages.some((p) => p.url.endsWith('/empty')))
})

Deno.test('pagesFromItems: falls back to crawl.loadedUrl and markdown text; ignores junk', () => {
  const pages = pagesFromItems([
    { crawl: { loadedUrl: 'https://acme-pm.com/about' }, markdown: '# About\nWe manage 300 doors.' },
    null,
    'x',
    { url: 'ftp://acme-pm.com/', text: 'nope' },
  ] as unknown[])
  assertEquals(pages, [{ url: 'https://acme-pm.com/about', text: '# About\nWe manage 300 doors.', links: [] }])
})

Deno.test('parseMonthlyUsage: after-discount total, else before, else null', () => {
  assertEquals(parseMonthlyUsage({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 12.5, totalUsageCreditsUsdBeforeVolumeDiscount: 13 } }), 12.5)
  assertEquals(parseMonthlyUsage({ data: { totalUsageCreditsUsdBeforeVolumeDiscount: 3 } }), 3)
  assertEquals(parseMonthlyUsage({ data: {} }), null)
  assertEquals(parseMonthlyUsage(null), null)
  assertEquals(parseMonthlyUsage({ data: { totalUsageCreditsUsdAfterVolumeDiscount: -1 } }), null)
})

Deno.test('parseCap: LUME_RESEARCH_APIFY_CAP_USD, default 29, junk -> 29', () => {
  assertEquals(parseCap(undefined), 29)
  assertEquals(parseCap(''), 29)
  assertEquals(parseCap('40'), 40)
  assertEquals(parseCap('12.5'), 12.5)
  assertEquals(parseCap('0'), 29)
  assertEquals(parseCap('-3'), 29)
  assertEquals(parseCap('lots'), 29)
})

Deno.test('pagesFromItems: html is cut to 200 KB before the link regex; links past it are ignored', () => {
  assertEquals(MAX_HTML_BYTES, 200_000)
  const pad = 'x'.repeat(MAX_HTML_BYTES)
  const pages = pagesFromItems([{
    url: 'https://acme-pm.com/',
    text: 'home',
    html: `<a href="https://early.example.com/">Early</a>${pad}<a href="https://late.example.com/">Late</a>`,
  }])
  assertEquals(pages[0].links.map((l) => l.href), ['https://early.example.com/'])
})
