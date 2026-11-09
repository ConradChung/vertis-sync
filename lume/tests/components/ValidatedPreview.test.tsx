// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() }) }))

import { LeadsPreview, PreviewLeadsButton, RenamableName } from '@/components/validate/ValidatedPreview'
import { ProgressCard } from '@/components/progress/RunningNow'
import type { ProgressItem } from '@/lib/progress/model'

const JOB = '16f26ffc-f8e5-47a5-9e1b-7532f61dad75'
const counts = { valid: 4563, invalid: 391, error: 284, no_email: 17, pending: 0, all: 5255 }
const page = (url: string) => {
  const sp = new URLSearchParams(url.split('?')[1])
  const status = sp.get('status') ?? 'valid'
  const p = Number(sp.get('page'))
  return {
    job: { id: JOB, name: 'UK agents', filename: 'leadsfriday-4445.csv', display_name: 'UK agents', status: 'completed', total_rows: 5255, created_at: '2026-11-06T10:00:00Z', enrich: true, instantly_status: null, instantly_campaign_id: null, instantly_campaign_name: null },
    columns: { original: ['First Name', 'Company Name', 'Email'], enrichment: [{ key: 'operating_city', label: 'Operating city' }] },
    rows: [
      {
        id: `r${p}`,
        row_index: p * 100 + 1,
        email: 'ann@acme.com',
        status,
        status_label: status === 'invalid' ? 'Invalid' : 'Valid',
        reason: status === 'invalid' ? 'Catch-All' : 'Accepted',
        cells: ['Ann', 'Acme', 'ann@acme.com'],
        enrichment: ['Leeds'],
      },
    ],
    total: status === 'all' ? 5255 : status === 'invalid' ? 391 : 4563,
    page: p,
    page_size: 100,
    status,
    q: sp.get('q'),
    counts,
    editable: false,
    edit_block_reason: 'x',
  }
}
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'PATCH') return Response.json({ job: { id: JOB } })
  if (url.includes('/rows')) return Response.json(page(url))
  return Response.json({})
})
const wrap = (ui: ReactNode) => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>)
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]))

beforeEach(() => vi.stubGlobal('fetch', fetchMock))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

describe('LeadsPreview', () => {
  it('renders the original columns in order, then Status, then enrichment; Valid by default with counts', async () => {
    wrap(<LeadsPreview jobId={JOB} />)
    const table = await screen.findByRole('table', { name: 'Leads' })
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent)
    expect(heads).toEqual(['#', 'First Name', 'Company Name', 'Email', 'Status', 'Operating city'])
    expect(within(table).getAllByRole('row')[1].textContent).toContain('Leeds')
    expect(urls()[0]).toBe(`/api/validation-jobs/${JOB}/rows?page=0&status=valid`)
    expect(screen.getByRole('button', { name: /Valid\s*4,563/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getAllByText('Rows 1–100 of 4,563 · page 1 of 46')).toHaveLength(2)
  })

  it('switches filter (reason on hover) and pages', async () => {
    wrap(<LeadsPreview jobId={JOB} />)
    await screen.findByRole('table', { name: 'Leads' })
    fireEvent.click(screen.getByRole('button', { name: /Invalid\s*391/ }))
    await waitFor(() => expect(urls()).toContain(`/api/validation-jobs/${JOB}/rows?page=0&status=invalid`))
    const status = await screen.findByTitle('Catch-All')
    expect(status.textContent).toContain('Invalid')
    fireEvent.click(screen.getByRole('button', { name: /All\s*5,255/ }))
    await waitFor(() => expect(urls()).toContain(`/api/validation-jobs/${JOB}/rows?page=0&status=all`))
    fireEvent.click(screen.getAllByRole('button', { name: 'Next page' })[0])
    await waitFor(() => expect(urls()).toContain(`/api/validation-jobs/${JOB}/rows?page=1&status=all`))
  })

  it('searches (debounced) and links the CSV downloads', async () => {
    wrap(<LeadsPreview jobId={JOB} />)
    await screen.findByRole('table', { name: 'Leads' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search leads' }), { target: { value: 'acme co' } })
    await waitFor(() => expect(urls()).toContain(`/api/validation-jobs/${JOB}/rows?page=0&status=valid&q=acme%20co`))
    expect(screen.getByText('Valid CSV').closest('a')?.getAttribute('href')).toBe(`/api/validation-jobs/${JOB}/export?status=valid`)
    expect(screen.getByText('All CSV').closest('a')?.getAttribute('href')).toBe(`/api/validation-jobs/${JOB}/export?status=all`)
  })
})

describe('RenamableName', () => {
  it('click → input; Enter saves through PATCH; Escape cancels', async () => {
    wrap(<RenamableName jobId={JOB} name="5,255 leads · 06 Nov" />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename 5,255 leads · 06 Nov' }))
    const input = screen.getByRole('textbox', { name: 'List name' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'List name' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Rename/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'List name' }), { target: { value: ' UK agents ' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'List name' }), { key: 'Enter' })
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')).toBe(true))
    const call = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')!
    expect(call[0]).toBe(`/api/validation-jobs/${JOB}`)
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ display_name: 'UK agents' })
  })
})

describe('Progress preview icon', () => {
  const item = (o: Partial<ProgressItem>): ProgressItem => ({
    key: 'k', kind: 'validation', label: 'Validation', title: 'UK agents', status: 'completed', stage: null, done: 5255, total: 5255, eta_seconds: null, eta_updated_at: null,
    cost_usd: null, cap_usd: null, started_at: new Date().toISOString(), updated_at: new Date().toISOString(), finished: true, error: null, href: null, external: false, job_id: JOB, ...o,
  })

  it('validation cards carry a "Preview leads" button that opens the preview', async () => {
    wrap(<ProgressCard item={item({})} now={Date.now()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview leads' }))
    expect(await screen.findByRole('table', { name: 'Leads' })).toBeTruthy()
  })

  it('other kinds do not', () => {
    wrap(<ProgressCard item={item({ kind: 'apify', job_id: undefined })} now={Date.now()} />)
    expect(screen.queryByRole('button', { name: 'Preview leads' })).toBeNull()
  })

  it('the button stands alone too', () => {
    wrap(<PreviewLeadsButton jobId={JOB} />)
    expect(screen.getByRole('button', { name: 'Preview leads' })).toBeTruthy()
  })
})
