// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MapsCard } from '@/components/import/MapsCard'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

describe('MapsCard', () => {
  it('Request files the scrape for approval and links to it; nothing runs here', async () => {
    const fetch = answer(201, { ok: true, action: { id: 'A1', kind: 'run_actor', summary: 'Run Google Maps Scraper\nmore' }, areas: 48, dropped_fields: [] })
    vi.stubGlobal('fetch', fetch)
    render(<MapsCard />)
    fireEvent.click(screen.getByRole('button', { name: /request the scrape/i }))
    await waitFor(() => expect(screen.getByRole('link', { name: /review and confirm/i }).getAttribute('href')).toBe('/actions/A1'))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('/api/maps/scrape')
    expect(screen.getByText(/Filed for approval: Run Google Maps Scraper\./)).toBeTruthy()
  })

  it('Build is off until a run id is typed, then links to the new list', async () => {
    const fetch = answer(201, {
      ok: true, list_id: 'L1', list_name: 'LA PM', href: '/import/leads?list=L1', summary: '2 companies kept of 3 places.', truncated: false, run_status: 'SUCCEEDED',
      append: { added: 2, duplicates: 0, over_cap: 0, item_count: 2 }, clean: { kept: 2, with_phone: 2, pm_category: 2, total: 3 },
    })
    vi.stubGlobal('fetch', fetch)
    render(<MapsCard />)
    const build = screen.getByRole('button', { name: /^build$/i })
    expect((build as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/build the sheet/i), { target: { value: 'AbCdEfGh1234' } })
    fireEvent.click(build)
    await waitFor(() => expect(screen.getByRole('link', { name: /open the sheet/i }).getAttribute('href')).toBe('/import/leads?list=L1'))
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ run_id: 'AbCdEfGh1234' })
  })

  it('a duplicate request links to the waiting one', async () => {
    vi.stubGlobal('fetch', answer(409, { error: 'duplicate', existing_id: 'A0' }))
    render(<MapsCard />)
    fireEvent.click(screen.getByRole('button', { name: /request the scrape/i }))
    await waitFor(() => expect(screen.getByRole('link', { name: /open it/i }).getAttribute('href')).toBe('/actions/A0'))
  })
})
