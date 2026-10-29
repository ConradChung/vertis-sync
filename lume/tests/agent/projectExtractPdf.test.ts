import { afterEach, describe, expect, it, vi } from 'vitest'

/** unpdf mocked: a fake document whose pages and timing the test controls. */
const pdf = vi.hoisted(() => ({
  numPages: 3,
  pageText: (i: number) => `page ${i}`,
  hang: false,
  hangAt: 0,
  getPage: vi.fn(),
  destroy: vi.fn(),
}))
vi.mock('unpdf', () => ({
  getDocumentProxy: vi.fn(async () => {
    if (pdf.hang) return new Promise(() => {})
    return {
      numPages: pdf.numPages,
      destroy: pdf.destroy,
      getPage: pdf.getPage.mockImplementation(async (i: number) =>
        i === pdf.hangAt ? new Promise(() => {}) : { getTextContent: async () => ({ items: [{ str: pdf.pageText(i) }] }) }
      ),
    }
  }),
}))

import { extractText, PDF_MAX_PAGES } from '@/lib/agent/projectExtract'
import { MAX_TEXT_CHARS } from '@/lib/agent/projectModel'

afterEach(() => {
  pdf.numPages = 3
  pdf.pageText = (i) => `page ${i}`
  pdf.hang = false
  pdf.hangAt = 0
  pdf.getPage.mockReset()
  pdf.destroy.mockReset()
})

describe('PDF extraction limits', () => {
  it('reads each page in order', async () => {
    const r = await extractText(new Uint8Array([1]), 'pdf')
    expect(r).toEqual({ text: 'page 1\npage 2\npage 3', readable: true, truncated: false })
  })

  it('a PDF that takes too long is not readable (and the document is released)', async () => {
    pdf.hang = true
    const r = await extractText(new Uint8Array([1]), 'pdf', { pdfTimeoutMs: 20 })
    expect(r).toEqual({ text: null, readable: false, truncated: false })
  })

  it('a page that hangs mid-way also times out', async () => {
    pdf.numPages = 5
    pdf.hangAt = 2
    const r = await extractText(new Uint8Array([1]), 'pdf', { pdfTimeoutMs: 20 })
    expect(r.readable).toBe(false)
    expect(pdf.destroy).toHaveBeenCalled()
  })

  it(`stops at ${PDF_MAX_PAGES} pages, marked truncated`, async () => {
    pdf.numPages = PDF_MAX_PAGES + 50
    const r = await extractText(new Uint8Array([1]), 'pdf')
    expect(pdf.getPage).toHaveBeenCalledTimes(PDF_MAX_PAGES)
    expect(r.truncated).toBe(true)
  })

  it('stops collecting once past the character cap', async () => {
    pdf.numPages = 100
    pdf.pageText = () => 'y'.repeat(50_000)
    const r = await extractText(new Uint8Array([1]), 'pdf')
    expect(pdf.getPage.mock.calls.length).toBeLessThan(10)
    expect(r.text!.length).toBe(MAX_TEXT_CHARS)
    expect(r.truncated).toBe(true)
  })
})
