import 'server-only'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Server-side page reader for the agent's `open_website` tool: a fallback for
 * sites that block Anthropic's web_fetch. Public http(s) only — private,
 * loopback, link-local and metadata addresses are refused at every redirect.
 */

export const PAGE_MAX_BYTES = 2 * 1024 * 1024
export const PAGE_MAX_TEXT = 20_000
const TIMEOUT_MS = 12_000
const MAX_REDIRECTS = 4
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

export class PageError extends Error {
  constructor(
    readonly code: 'bad_url' | 'blocked_address' | 'http_error' | 'unsupported_type' | 'too_large' | 'timeout' | 'fetch_failed',
    message: string,
    readonly status = 0
  ) {
    super(message)
  }
}

/** Accepts `d3.com`, `www.d3.com/about` or a full URL; returns a normalised http(s) URL. */
export function normaliseUrl(raw: string): URL {
  const s = raw.trim()
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    throw new PageError('bad_url', 'Not a valid URL')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new PageError('bad_url', 'Only http(s) URLs')
  if (u.username || u.password) throw new PageError('bad_url', 'Credentials in URLs are not allowed')
  if (u.port && u.port !== '80' && u.port !== '443') throw new PageError('bad_url', 'Only ports 80 and 443')
  if (!u.hostname.includes('.') || /\.(local|internal|localhost)$/i.test(u.hostname)) throw new PageError('bad_url', 'Not a public host')
  return u
}

/** True for addresses an outbound fetch must never reach. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    )
  }
  const v = ip.toLowerCase()
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7))
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff')
}

async function assertPublic(host: string) {
  const h = host.replace(/^\[|\]$/g, '')
  const addrs = isIP(h) ? [{ address: h }] : await lookup(h, { all: true }).catch(() => [])
  if (!addrs.length) throw new PageError('fetch_failed', `Could not resolve ${host}`)
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new PageError('blocked_address', 'That host resolves to a private address')
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })

export interface PageResult {
  url: string
  status: number
  title: string | null
  description: string | null
  text: string
  truncated: boolean
  links: { text: string; url: string }[]
  /** 'jina' when the page only renders with JavaScript and was read via Jina Reader. */
  rendered_by?: 'jina'
}

/** Below this much readable text the page is probably a JavaScript app. */
const MIN_STATIC_TEXT = 300
const JINA_TIMEOUT_MS = 25_000

/**
 * JavaScript-rendered sites (SPAs) have no text in their HTML. Jina Reader
 * renders the public page and returns Markdown; only the public URL is sent.
 * `JINA_API_KEY` is optional (raises the free rate limit).
 */
export async function renderWithJina(url: URL, fetchImpl: typeof fetch = fetch): Promise<Omit<PageResult, 'status'> | null> {
  const headers: Record<string, string> = { Accept: 'text/plain', 'X-Return-Format': 'markdown' }
  const key = process.env.JINA_API_KEY?.trim()
  if (key) headers.Authorization = `Bearer ${key}`
  try {
    const res = await fetchImpl(`https://r.jina.ai/${url.toString()}`, { headers, signal: AbortSignal.timeout(JINA_TIMEOUT_MS) })
    if (!res.ok) return null
    const md = (await readCapped(res)).trim()
    const body = md.replace(/^[\s\S]*?Markdown Content:\s*/, '')
    if (body.length < 40) return null
    const title = /^Title:\s*(.+)$/m.exec(md)?.[1]?.trim() ?? null
    const links: { text: string; url: string }[] = []
    const seen = new Set<string>()
    const host = url.hostname.replace(/^www\./, '')
    for (const m of body.matchAll(/(?<!!)\[([^\]]{1,80})\]\((https?:\/\/[^)\s]+)\)/g)) {
      try {
        const u = new URL(m[2])
        if (!u.hostname.replace(/^www\./, '').endsWith(host) || seen.has(u.toString())) continue
        seen.add(u.toString())
        links.push({ text: m[1].trim(), url: u.toString() })
        if (links.length >= 40) break
      } catch {
        // ignore
      }
    }
    const text = body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\n{3,}/g, '\n\n')
    return { url: url.toString(), title, description: null, text: text.slice(0, PAGE_MAX_TEXT), truncated: text.length > PAGE_MAX_TEXT, links, rendered_by: 'jina' }
  } catch {
    return null
  }
}

/** Readable text, title, description and same-site links from an HTML page. */
export function extractPage(html: string, base: URL): Omit<PageResult, 'url' | 'status'> {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const desc =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1]
  const links: { text: string; url: string }[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const u = new URL(decode(m[1]), base)
      if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '') || seen.has(u.pathname)) continue
      const text = decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
      if (!text || text.length > 80) continue
      seen.add(u.pathname)
      links.push({ text, url: u.toString() })
      if (links.length >= 40) break
    } catch {
      // ignore bad hrefs
    }
  }
  const body = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br|header|footer|main)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const text = decode(body)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  return {
    title: title ? decode(title).replace(/\s+/g, ' ').trim() || null : null,
    description: desc ? decode(desc).trim() || null : null,
    text: text.slice(0, PAGE_MAX_TEXT),
    truncated: text.length > PAGE_MAX_TEXT,
    links,
  }
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > PAGE_MAX_BYTES) {
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export async function fetchPage(raw: string, fetchImpl: typeof fetch = fetch): Promise<PageResult> {
  let url = normaliseUrl(raw)
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  try {
    for (let hop = 0; ; hop++) {
      await assertPublic(url.hostname)
      const res = await fetchImpl(url, {
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.9' },
      })
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop >= MAX_REDIRECTS) throw new PageError('fetch_failed', 'Too many redirects')
        url = normaliseUrl(new URL(res.headers.get('location')!, url).toString())
        continue
      }
      if (!res.ok) throw new PageError('http_error', `The site answered ${res.status}`, res.status)
      const type = res.headers.get('content-type') ?? ''
      if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) throw new PageError('unsupported_type', `Not a web page (${type.split(';')[0]})`)
      const html = await readCapped(res)
      const page = /text\/plain/i.test(type) ? { title: null, description: null, text: html.slice(0, PAGE_MAX_TEXT), truncated: html.length > PAGE_MAX_TEXT, links: [] } : extractPage(html, url)
      if (page.text.length < MIN_STATIC_TEXT && !/text\/plain/i.test(type)) {
        const rendered = await renderWithJina(url, fetchImpl)
        if (rendered) return { ...rendered, status: res.status, title: rendered.title ?? page.title, description: page.description }
      }
      return { url: url.toString(), status: res.status, ...page }
    }
  } catch (err) {
    if (err instanceof PageError) throw err
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new PageError('timeout', 'The site took too long to answer')
    throw new PageError('fetch_failed', err instanceof Error ? err.message : 'Fetch failed')
  }
}
