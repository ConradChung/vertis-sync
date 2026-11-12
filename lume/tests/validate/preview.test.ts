import { describe, expect, it } from 'vitest'
import {
  applySentCompanyNames,
  cellText,
  emailCompanyColumn,
  DisplayNameBody,
  jobName,
  pageBounds,
  parsePreviewQuery,
  previewColumns,
  searchPattern,
  searchTerm,
  statusLabel,
  toPreviewRow,
  type PreviewRow,
  type RawPreviewRow,
} from '@/lib/validate/preview'

const raw = (o: Partial<RawPreviewRow> = {}): RawPreviewRow => ({
  id: 'r1',
  row_index: 3,
  email: 'ann@acme.com',
  status: 'invalid',
  validation_result: { code: 'ko', message: 'Catch-All' },
  enrichment_status: null,
  enrichment: null,
  instantly_status: null,
  row_data: { 'First Name': 'Ann', 'Last Name': 'Lee', Email: 'ann@acme.com', Company: 'Acme', extra: 'x' },
  ...o,
})

describe('previewColumns', () => {
  it('keeps column_order order (deduped), then enrichment columns the CSV lacks, only for enriched jobs', () => {
    const c = previewColumns(['Email', 'First Name', 'Email', 'operating_city', ''], true)
    expect(c.original).toEqual(['Email', 'First Name', 'operating_city'])
    expect(c.enrichment.map((e) => e.label)).toEqual(['Secondary cities', 'City confidence', 'ICP'])
    expect(previewColumns(['Email'], false).enrichment).toEqual([])
  })

  it('falls back to the row_data keys, first seen first, when the job has no column_order', () => {
    expect(previewColumns(null, false, [{ row_data: { b: 1, a: 2 } }, { row_data: { a: 3, c: 4 } }]).original).toEqual(['b', 'a', 'c'])
  })
})

describe('toPreviewRow', () => {
  it('maps row_data to the ordered columns, with status label, reason and enrichment', () => {
    const cols = previewColumns(['Email', 'First Name', 'Missing'], true)
    const r = toPreviewRow(raw({ enrichment: { operating_city: 'Leeds', icp_status: 'confirmed' } }), cols)
    expect(r.cells).toEqual(['ann@acme.com', 'Ann', null])
    expect(r.status_label).toBe('Invalid')
    expect(r.reason).toBe('Catch-All')
    expect(r.enrichment).toEqual(['Leeds', null, null, 'confirmed'])
    expect(r.edit).toBeUndefined()
  })

  it('carries the editor view only while editable', () => {
    const r = toPreviewRow(raw({ status: 'pending' }), previewColumns(['First Name', 'Last Name', 'Company'], false), true)
    expect(r.edit?.first_name).toBe('Ann')
    expect(r.edit?.company_name).toBe('Acme')
  })

  it('labels every status', () => {
    expect(['valid', 'invalid', 'error', 'no_email', 'pending'].map(statusLabel)).toEqual(['Valid', 'Invalid', 'Error', 'No email', 'Pending'])
  })

  it('prints cells: numbers, booleans, arrays, objects; blanks are null', () => {
    expect(cellText(12)).toBe('12')
    expect(cellText(false)).toBe('false')
    expect(cellText(['a', 'b'])).toBe('a, b')
    expect(cellText({ a: 1 })).toBe('{"a":1}')
    expect(cellText('  ')).toBeNull()
    expect(cellText(undefined)).toBeNull()
  })
})

describe('search', () => {
  it('escapes % and _ for ILIKE', () => {
    expect(searchPattern('50%_off')).toBe('%50\\%\\_off%')
    expect(searchPattern('acme')).toBe('%acme%')
  })

  it('strips quotes, backslashes and control characters, trims and caps the term', () => {
    expect(searchTerm('  "ann\\" \n')).toBe('ann')
    expect(searchTerm('   ')).toBeNull()
    expect(searchTerm(null)).toBeNull()
    expect(searchTerm('x'.repeat(300))).toHaveLength(100)
  })
})

describe('parsePreviewQuery / pageBounds', () => {
  const p = (qs: string) => parsePreviewQuery(new URLSearchParams(qs))
  it('defaults to page 0, status valid, no search', () => {
    expect(p('')).toEqual({ ok: true, query: { page: 0, status: 'valid', q: null } })
    expect(p('page=2&status=all&q=%20acme%20')).toEqual({ ok: true, query: { page: 2, status: 'all', q: 'acme' } })
  })

  it('refuses bad pages and statuses', () => {
    expect(p('page=-1')).toEqual({ ok: false, error: 'bad_page' })
    expect(p('page=1.5')).toEqual({ ok: false, error: 'bad_page' })
    expect(p('page=10000')).toEqual({ ok: false, error: 'bad_page' })
    expect(p('status=pending')).toEqual({ ok: false, error: 'bad_status' })
  })

  it('pages by 100 and knows when a page lies past the total', () => {
    expect(pageBounds(0, 4563)).toEqual({ from: 0, to: 99, past: false })
    expect(pageBounds(45, 4563)).toEqual({ from: 4500, to: 4599, past: false })
    expect(pageBounds(46, 4563).past).toBe(true)
    expect(pageBounds(0, 0).past).toBe(true)
  })
})

describe('DisplayNameBody / jobName', () => {
  const parse = (v: unknown) => DisplayNameBody.safeParse(v)
  it('trims and collapses spaces; empty or null resets', () => {
    expect(parse({ display_name: '  UK   agents  ' }).data).toEqual({ display_name: 'UK agents' })
    expect(parse({ display_name: '   ' }).data).toEqual({ display_name: null })
    expect(parse({ display_name: null }).data).toEqual({ display_name: null })
  })

  it('refuses names over 120 characters, extra keys and missing field', () => {
    expect(parse({ display_name: 'x'.repeat(121) }).success).toBe(false)
    expect(parse({ display_name: 'x'.repeat(120) }).success).toBe(true)
    expect(parse({ display_name: 'a', other: 1 }).success).toBe(false)
    expect(parse({}).success).toBe(false)
  })

  it('names a job by display_name, else its size and day', () => {
    expect(jobName({ display_name: 'UK agents', total_rows: 5255, created_at: '2026-11-06T10:00:00Z' })).toBe('UK agents')
    expect(jobName({ display_name: null, total_rows: 5255, created_at: '2026-11-06T10:00:00Z' })).toBe('5,255 leads · 06 Nov')
  })
})

describe('sent company names', () => {
  const row = (email: string | null, company: string | null) =>
    ({ id: email ?? 'x', row_index: 0, email, status: 'valid', status_label: 'Valid', reason: null, cells: ['a', company], enrichment: [] }) as PreviewRow

  it('targets "Company Name for Emails", never the raw Company Name column', () => {
    expect(emailCompanyColumn(['Company Name', 'Company Name for Emails', 'Email'])).toBe(1)
    expect(emailCompanyColumn(['company_name_for_emails'])).toBe(0)
    expect(emailCompanyColumn(['Email', 'Company Name'])).toBeNull()
  })

  it('shows the sent name and keeps the CSV original; unbanked and unchanged rows are untouched', () => {
    const sent = new Map([['ann@jfm.co.uk', 'JFM Block & Estate Management'], ['bo@x.com', 'Same']])
    const [a, b, c] = applySentCompanyNames(
      [row('Ann@JFM.co.uk', 'Jfm Block & Estate Management Ltd'), row('bo@x.com', 'Same'), row('cy@y.com', 'Raw')],
      1,
      sent,
    )
    expect(a.cells[1]).toBe('JFM Block & Estate Management')
    expect(a.company_original).toBe('Jfm Block & Estate Management Ltd')
    expect(b.company_original).toBeUndefined()
    expect(c.cells[1]).toBe('Raw')
  })
})
