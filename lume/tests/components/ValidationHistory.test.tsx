// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { ValidationHistory } from '@/components/validate/ValidationHistory'

const row = (i: number) => ({ id: `j${i}`, title: `5,385 leads · 22 Aug`, filename: 'f.csv', source: i % 2 ? 'Leadsfriday (Apollo link)' : 'CSV import', total: 5385, created_at: '2026-08-22T09:51:03Z', valid_pct: 60.9, invalid_rate: 36, error_pct: 4.9, no_email: 1903, top_invalid: 'Catch-All (1,546)' })
const fetchMock = vi.fn(async (url: string) => {
  const page = Number(new URLSearchParams(url.split('?')[1]).get('page'))
  return Response.json({ rows: [row(page * 25 + 1)], total: 30, page, page_size: 25 })
})
beforeEach(() => vi.stubGlobal('fetch', fetchMock))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

describe('ValidationHistory', () => {
  it('is collapsed until opened; then one row per completed job with source, %s and top invalid reason, paged', async () => {
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><ValidationHistory /></SWRConfig>)
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Validation history'))
    const table = await screen.findByRole('table', { name: 'Validation history' })
    const cells = within(table).getAllByRole('row')[1].textContent
    expect(cells).toContain('Leadsfriday (Apollo link)')
    expect(cells).toContain('60.9%')
    expect(cells).toContain('36.0%')
    expect(cells).toContain('Catch-All (1,546)')
    expect(screen.getByText('1–25 of 30 · last 30 days')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('page=1'))).toBe(true))
  })
})
