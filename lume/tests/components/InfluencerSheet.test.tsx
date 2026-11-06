// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() }) }))

import { InfluencerSheet } from '@/components/leads/InfluencerSheet'

const B1 = '11111111-1111-4111-8111-111111111111'
const cand = (o: Record<string, unknown>) => ({
  id: 'c', batch_id: B1, row_index: 0, name: 'X', title: null, company: null, category: null, notes: null, source_context: null,
  linkedin_url: null, confidence: null, evidence: null, status: 'pending_lookup', influencer_id: null, lookup_attempts: 0, lookup_error: null, updated_at: '', ...o,
})
const CANDS = [
  cand({ id: 'c1', name: 'Sarah Johnson', title: 'Director', company: 'Greystar', linkedin_url: 'https://www.linkedin.com/in/sarah-johnson', confidence: 'high', evidence: { url: 'https://www.linkedin.com/in/sarah-johnson', snippet: 'Sarah Johnson - Director - Greystar' }, status: 'found' }),
  cand({ id: 'c2', name: 'Mo Lee', company: 'Acme', linkedin_url: 'https://www.linkedin.com/in/mo-lee', confidence: 'medium', evidence: { url: 'https://acme.com/team', snippet: 'Mo Lee runs ops at Acme' }, status: 'found' }),
  cand({ id: 'c3', name: 'Zed Nobody', confidence: 'not_found', status: 'not_found' }),
  cand({ id: 'c4', name: 'Pat High', linkedin_url: 'https://www.linkedin.com/in/pat', confidence: 'high', status: 'found', possible_duplicate_of: 'inf-9' }),
]

let fetchMock: ReturnType<typeof vi.fn>
let pending = 0
let batchStatus = 'done'
beforeEach(() => {
  pending = 0
  batchStatus = 'done'
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/influencers/candidates') return Response.json({ batches: [{ id: B1, name: 'influencers.xlsx · People', status: 'done', spent_usd: 0.9, max_lookup_usd: 1.19, counts: { found: 3, not_found: 1 }, created_at: new Date().toISOString() }] })
    if (url === `/api/influencers/candidates/${B1}`) return Response.json({ batch: { id: B1, name: 'influencers.xlsx · People', status: batchStatus, spent_usd: 0.9, max_lookup_usd: 1.19 }, candidates: CANDS, counts: { found: 3, not_found: 1, pending_lookup: pending }, estimate: { people: pending, usd: pending * 0.0065, default_cap_usd: 0.1 } })
    if (url === '/api/actions') return Response.json({ id: 'a1' }, { status: 201 })
    if (url === '/api/influencers/candidates/review') return Response.json(JSON.parse(String(init?.body)).action === 'approve' ? { approved: [], skipped: [] } : { rejected: 1 })
    return Response.json({})
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const renderIt = () => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><InfluencerSheet batchId={B1} name="influencers.xlsx · People" /></SWRConfig>)
const reviewBodies = () => fetchMock.mock.calls.filter((c) => c[0] === '/api/influencers/candidates/review').map((c) => JSON.parse(String((c[1] as RequestInit).body)))

describe('InfluencerSheet', () => {
  it('a sheet with the candidate columns', async () => {
    renderIt()
    const table = await screen.findByRole('table', { name: 'influencers.xlsx · People candidates' })
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent).slice(1)).toEqual([
      'Name', 'Title', 'Company', 'Category', 'Notes', 'LinkedIn', 'Confidence', 'Evidence', 'Status', 'Possible duplicate', '',
    ])
  })

  it('Approve / Reject selected', async () => {
    renderIt()
    await screen.findByText('Mo Lee')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Mo Lee' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Zed Nobody' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject selected (2)' }))
    await waitFor(() => expect(reviewBodies()).toEqual([{ action: 'reject', ids: ['c2', 'c3'] }]))
  })

  it('"Look up LinkedIn (≈$X)" files the influencer_lookup approval (nothing runs until it is confirmed)', async () => {
    pending = 40
    batchStatus = 'staged'
    renderIt()
    fireEvent.click(await screen.findByRole('button', { name: 'Look up LinkedIn (≈$0.26)' }))
    await waitFor(() => expect(fetchMock.mock.calls.find((c) => c[0] === '/api/actions')?.[1]).toBeTruthy())
    const body = JSON.parse(String((fetchMock.mock.calls.find((c) => c[0] === '/api/actions')![1] as RequestInit).body))
    expect(body).toEqual({ kind: 'influencer_lookup', payload: { batch_id: B1 } })
  })

  it('shows each candidate with the found URL as a link, confidence and the evidence', async () => {
    renderIt()
    const row = (await screen.findByText('Sarah Johnson')).closest('tr')!
    const link = within(row).getByRole('link', { name: 'linkedin.com/in/sarah-johnson' }) as HTMLAnchorElement
    expect(link.href).toBe('https://www.linkedin.com/in/sarah-johnson')
    expect(link.rel).toContain('noopener')
    expect(within(row).getByText('high')).toBeTruthy()
    expect(within(row).getByText('Director')).toBeTruthy()
    expect(within(row).getByText('Greystar')).toBeTruthy()
    expect(within(row).getByText('Sarah Johnson - Director - Greystar')).toBeTruthy()
    const mo = screen.getByText('Mo Lee').closest('tr')!
    expect((within(mo).getByRole('link', { name: 'source: acme.com' }) as HTMLAnchorElement).href).toBe('https://acme.com/team')
    expect(within(screen.getByText('Pat High').closest('tr')!).getByText(/Same name as an existing influencer/)).toBeTruthy()
    // A not_found row has nothing to approve.
    const zed = screen.getByText('Zed Nobody').closest('tr')!
    expect(within(zed).queryByRole('button', { name: /Approve/ })).toBeNull()
  })

  it('"Approve all high" approves only the found, high-confidence ones', async () => {
    renderIt()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve all high (2)' }))
    await waitFor(() => expect(reviewBodies()).toEqual([{ action: 'approve', ids: ['c1', 'c4'] }]))
  })

  it('approve and reject one row', async () => {
    renderIt()
    const mo = (await screen.findByText('Mo Lee')).closest('tr')!
    fireEvent.click(within(mo).getByRole('button', { name: 'Approve Mo Lee' }))
    await waitFor(() => expect(reviewBodies()).toHaveLength(1))
    await waitFor(() => expect((within(mo).getByRole('button', { name: 'Reject Mo Lee' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(mo).getByRole('button', { name: 'Reject Mo Lee' }))
    await waitFor(() => expect(reviewBodies()).toEqual([{ action: 'approve', ids: ['c2'] }, { action: 'reject', ids: ['c2'] }]))
  })
})
