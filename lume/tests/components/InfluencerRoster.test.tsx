// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() }) }))
import { InfluencerRoster } from '@/components/influencers/InfluencerRoster'

const SHEET = '55555555-5555-4555-8555-555555555555'
const inf = (o: Record<string, unknown>) => ({
  id: 'i', name: 'X', slug: 'x', linkedin_url: 'https://www.linkedin.com/in/x', lookback_days: 90, max_reactions_per_post: 1000, active: true, notes: null,
  last_ran_at: null, last_posts: null, last_top_posts: null, last_reactions: null, last_reactors: null, last_leads: null, last_leads_700: null,
  last_apify_usd: null, last_perplexity_usd: null, last_haiku_usd: null, last_cost_usd: null, ...o,
})
const calls: { url: string; method: string; body?: unknown }[] = []
beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/influencers') return Response.json({ influencers: [inf({ id: 'a', name: 'Brad Randall', slug: 'brad', last_ran_at: '2026-10-08T00:00:00Z', last_posts: 12, last_reactors: 900, last_leads: 40, last_leads_700: 9, last_cost_usd: 1.5, notes: 'posts weekly' }), inf({ id: 'b', name: 'Quiet One', slug: 'quiet', active: false })], runs: [] })
    if (url === '/api/influencers/candidates') return Response.json({ batches: [{ id: 'b1', name: 'PM Influencers', status: 'done', counts: { found: 65 }, list_id: SHEET }] })
    return Response.json({ influencer: {} })
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('InfluencerRoster', () => {
  it('lists the actual influencers with active, last run stats and notes; toggling active PATCHes it', async () => {
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><InfluencerRoster /></SWRConfig>)
    const row = (await screen.findByText('Brad Randall')).closest('tr')!
    expect(row.textContent).toContain('12 posts · 900 reactors · 40 leads (9 at 700+) · $1.50')
    expect(row.textContent).toContain('posts weekly')
    const quiet = screen.getByText('Quiet One').closest('tr')!
    fireEvent.click(within(quiet).getByRole('switch', { name: 'Quiet One active' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toEqual({ url: '/api/influencers/quiet', method: 'PATCH', body: { active: true } }))
  })

  it('candidate lists are sheets in Leads now: the tab links to them', async () => {
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><InfluencerRoster /></SWRConfig>)
    const link = await screen.findByRole('link', { name: 'PM Influencers' })
    expect(link.getAttribute('href')).toBe(`/import/leads?list=${SHEET}`)
  })
})
