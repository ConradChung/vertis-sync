import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => (host === 'internal.example.com' ? [{ address: '10.0.0.5' }] : [{ address: '93.184.216.34' }])),
}))

import { PageError, extractPage, fetchPage, isPrivateAddress, normaliseUrl } from '@/lib/web/page'
import { htmlLinksToMarkdown } from '@/lib/agent/linkify'

const html = (body: string, type = 'text/html; charset=utf-8', status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': type, ...headers } })

describe('open_website page reader', () => {
  it('normalises bare domains and refuses non-public targets', () => {
    expect(normaliseUrl('d3.com').toString()).toBe('https://d3.com/')
    expect(() => normaliseUrl('ftp://d3.com')).toThrow(PageError)
    expect(() => normaliseUrl('http://localhost')).toThrow(PageError)
    expect(() => normaliseUrl('https://d3.com:8080')).toThrow(PageError)
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('169.254.169.254')).toBe(true)
    expect(isPrivateAddress('172.20.1.1')).toBe(true)
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true)
    expect(isPrivateAddress('93.184.216.34')).toBe(false)
  })

  it('extracts title, description, readable text and same-site links', () => {
    const page = extractPage(
      '<html><head><title>D3 &amp; Co</title><meta name="description" content="Domains, tokenized"></head><body>' +
        '<script>evil()</script><nav><a href="/about">About</a><a href="https://other.com/x">Other</a></nav>' +
        '<main><h1>Hello</h1><p>We serve registrars.</p></main></body></html>',
      new URL('https://d3.com/')
    )
    expect(page.title).toBe('D3 & Co')
    expect(page.description).toBe('Domains, tokenized')
    expect(page.text).toContain('We serve registrars.')
    expect(page.text).not.toContain('evil')
    expect(page.links).toEqual([{ text: 'About', url: 'https://d3.com/about' }])
  })

  it('follows redirects and blocks one that points at a private address', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(html('', 'text/html', 301, { location: 'https://www.d3.com/' }))
      .mockResolvedValueOnce(html('<title>D3</title><p>ok</p>'))
    const page = await fetchPage('d3.com', f as unknown as typeof fetch)
    expect(page.url).toBe('https://www.d3.com/')
    expect(page.title).toBe('D3')

    const g = vi.fn().mockResolvedValueOnce(html('', 'text/html', 302, { location: 'https://internal.example.com/' }))
    await expect(fetchPage('d3.com', g as unknown as typeof fetch)).rejects.toMatchObject({ code: 'blocked_address' })
  })

  it('reports site errors and non-page content plainly', async () => {
    await expect(fetchPage('d3.com', vi.fn().mockResolvedValue(html('no', 'text/html', 403)) as unknown as typeof fetch)).rejects.toMatchObject({ code: 'http_error', status: 403 })
    await expect(fetchPage('d3.com', vi.fn().mockResolvedValue(html('%PDF', 'application/pdf')) as unknown as typeof fetch)).rejects.toMatchObject({ code: 'unsupported_type' })
  })
})

describe('htmlLinksToMarkdown', () => {
  it('rewrites HTML anchors to Markdown links', () => {
    expect(htmlLinksToMarkdown('See <a href="https://dealroom.co/companies/d3/">Customers include registrars.</a> ok')).toBe(
      'See [Customers include registrars.](https://dealroom.co/companies/d3/) ok'
    )
    expect(htmlLinksToMarkdown("<a target='_blank' href='https://x.com/a b'><b>X</b></a>")).toBe('[X](https://x.com/a%20b)')
    expect(htmlLinksToMarkdown('plain [md](https://a.com)')).toBe('plain [md](https://a.com)')
  })
})

describe('JavaScript-rendered pages', () => {
  it('falls back to Jina Reader when the HTML has almost no text', async () => {
    const f = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.startsWith('https://r.jina.ai/'))
        return new Response(
          'Title: D3 Domains\n\nURL Source: https://d3.com/\n\nMarkdown Content:\n# The domain layer\n\nD3 tokenizes domains for registrars and investors. [About](https://d3.com/about.html) ![logo](https://d3.com/x.svg) [Elsewhere](https://other.com/)',
          { headers: { 'content-type': 'text/plain' } }
        )
      return new Response('<html><title>D3</title><div id="root"></div></html>', { headers: { 'content-type': 'text/html' } })
    })
    const page = await fetchPage('d3.com', f as unknown as typeof fetch)
    expect(page.rendered_by).toBe('jina')
    expect(page.title).toBe('D3 Domains')
    expect(page.text).toContain('tokenizes domains')
    expect(page.text).not.toContain('logo')
    expect(page.links).toEqual([{ text: 'About', url: 'https://d3.com/about.html' }])
  })
})

describe('htmlLinksToMarkdown — other tags', () => {
  it('drops cite/span tags, keeps text, converts emphasis, leaves code and placeholders alone', () => {
    expect(htmlLinksToMarkdown('<cite index="3-1,3-2">D3 sells to registrars.</cite> Next.')).toBe('D3 sells to registrars. Next.')
    expect(htmlLinksToMarkdown('<b>Bold</b> and <em>it</em><br>line')).toBe('**Bold** and *it*\nline')
    expect(htmlLinksToMarkdown('Approve at /actions/<id> and `<cite>` stays')).toBe('Approve at /actions/<id> and `<cite>` stays')
    expect(htmlLinksToMarkdown('```\n<span>x</span>\n```')).toBe('```\n<span>x</span>\n```')
  })
})
