// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => nav.params, useRouter: () => ({ push: vi.fn(), replace: nav.replace }), usePathname: () => '/import/leads' }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() }) }))

import { LeadsScreen } from '@/components/leads/LeadsScreen'

const P = '33333333-3333-4333-8333-333333333333'
const L1 = '11111111-1111-4111-8111-111111111111'
const L2 = '22222222-2222-4222-8222-222222222222'
const L3 = '44444444-4444-4444-8444-444444444444'
const list = (id: string, name: string, o: Record<string, unknown> = {}) => ({
  id, name, notes: null, created_by: 'agent', project_id: null, project_default: false, item_count: 120, email_count: 80,
  sent_ingest_id: null, sent_at: null, sent_rows: null, sent_job_id: null, columns: ['title', 'author.name', 'email'], created_at: '2026-11-05T00:00:00Z', updated_at: new Date().toISOString(), ...o,
})
let folders: unknown[] = []
const calls: { url: string; method: string; body?: unknown }[] = []
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
  if (url === '/api/lead-lists') return Response.json({ folders })
  if (url.startsWith('/api/influencers/candidates/')) return Response.json({ batch: { id: 'b', name: 'PM Influencers', status: 'done', spent_usd: 0, max_lookup_usd: null }, candidates: [], counts: {}, estimate: { people: 0, usd: 0, default_cap_usd: 0 } })
  if (url.startsWith(`/api/lead-lists/${L1}/items?`)) {
    return Response.json({ rows: [{ idx: 0, item: { name: 'Acme', email: 'jane@acme.co' }, cells: { title: 'Acme', 'author.name': 'Jane', email: 'jane@acme.co' }, source: 'actor_run' }, { idx: 1, item: { name: 'Beta', email: null }, cells: { title: 'Beta' }, source: 'actor_run' }], total: 2, page: 0, page_size: 50 })
  }
  if (url.startsWith(`/api/lead-lists/${L3}/items?`)) {
    const page = Number(new URLSearchParams(url.split('?')[1]).get('page'))
    return Response.json({ rows: [{ idx: page * 100, item: {}, cells: { title: `Row ${page * 100 + 1}` }, source: 'actor_run' }], total: 4312, page, page_size: 100 })
  }
  if (url.startsWith(`/api/lead-lists/${L2}/items?`)) return Response.json({ rows: [], total: 0, page: 0, page_size: 50 })
  if (url === `/api/lead-lists/${L1}/items/1` && method === 'PATCH') return Response.json({ row: { idx: 1, item: { name: 'Beta', email: 'b@beta.co' } } })
  if (url === `/api/lead-lists/${L1}/send`) return Response.json({ ingest_id: 'i1', rows: 80 }, { status: 201 })
  return Response.json({})
})
const fresh = () => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><LeadsScreen /></SWRConfig>)

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', fetchMock)
  nav.params = new URLSearchParams()
  folders = [
    { id: P, name: 'Roofers TX', lists: [list(L1, 'Roofers TX', { project_id: P, project_default: true })] },
    { id: null, name: 'Unfiled', lists: [list(L2, 'Loose', { email_count: 0 })] },
  ]
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('LeadsScreen', () => {
  it('shows folders (projects, then Unfiled) with their lists, row counts and email coverage', async () => {
    fresh()
    const tree = await screen.findByRole('navigation', { name: 'Lead lists' })
    expect(within(tree).getByText('Roofers TX', { selector: 'summary *' })).toBeTruthy()
    expect(within(tree).getByText('Unfiled', { selector: 'summary *' })).toBeTruthy()
    expect(within(tree).getAllByText(/120 rows · 67% email/).length).toBe(1)
    expect(within(tree).getByText(/120 rows · 0% email/)).toBeTruthy()
  })

  it('?list= selects that list (its folder open) and loads its rows', async () => {
    nav.params = new URLSearchParams(`list=${L1}`)
    fresh()
    const table = await screen.findByRole('table', { name: 'Roofers TX rows' })
    expect(await within(table).findByText('jane@acme.co')).toBeTruthy()
    // The actor's own columns, in its order; a nested field is not sortable, a plain one is.
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent).slice(2, 5)).toEqual(['title', 'author.name', 'email'])
    expect(within(table).getByRole('button', { name: 'title' })).toBeTruthy()
    expect(within(table).queryByRole('button', { name: 'author.name' })).toBeNull()
    expect((screen.getByText('Roofers TX', { selector: 'summary *' }).closest('details') as HTMLDetailsElement).open).toBe(true)
  })

  it('edits a cell inline (PATCH the one field)', async () => {
    nav.params = new URLSearchParams(`list=${L1}`)
    fresh()
    const table = await screen.findByRole('table', { name: 'Roofers TX rows' })
    await within(table).findByText('jane@acme.co')
    fireEvent.click(within(table).getByRole('button', { name: 'Edit email, row 2' }))
    const input = within(table).getByRole('textbox', { name: 'email, row 2' })
    fireEvent.change(input, { target: { value: 'b@beta.co' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toEqual({ url: `/api/lead-lists/${L1}/items/1`, method: 'PATCH', body: { column: 'email', value: 'b@beta.co' } }))
  })

  it('send to validator: the confirm says how many rows have an email; confirming posts once', async () => {
    nav.params = new URLSearchParams(`list=${L1}`)
    fresh()
    await screen.findByRole('table', { name: 'Roofers TX rows' })
    fireEvent.click(screen.getByRole('button', { name: 'Send to validator' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('80 of 120 rows have an email')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send 80 rows' }))
    await waitFor(() => expect(calls.filter((c) => c.url === `/api/lead-lists/${L1}/send` && c.method === 'POST')).toHaveLength(1))
  })

  it('a list with no emails cannot be sent (and says why); export is a download link', async () => {
    nav.params = new URLSearchParams(`list=${L2}`)
    folders = [{ id: null, name: 'Unfiled', lists: [list(L2, 'Loose', { email_count: 0 })] }]
    fresh()
    const send = await screen.findByRole('button', { name: 'Send to validator' })
    expect((send as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('No row has an email yet')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href')).toBe(`/api/lead-lists/${L2}/export`)
  })

  it('pages 100 at a time with a clear pager (both ends disabled), the page in the URL, arrow keys, and the next page prefetched', async () => {
    folders = [{ id: null, name: 'Unfiled', lists: [list(L3, 'Big', { item_count: 4312, email_count: 4000 })] }]
    nav.params = new URLSearchParams(`list=${L3}&page=2`)
    fresh()
    const table = await screen.findByRole('table', { name: 'Big rows' })
    expect(await within(table).findByText('Row 101')).toBeTruthy()
    expect(screen.getAllByText('Rows 101–200 of 4,312 · page 2 of 44')).toHaveLength(2) // above and below
    const itemCalls = () => calls.filter((c) => c.url.startsWith(`/api/lead-lists/${L3}/items?`)).map((c) => new URLSearchParams(c.url.split('?')[1]))
    await waitFor(() => expect(itemCalls().some((p) => p.get('page') === '2')).toBe(true)) // the next page (0-based 2 = page 3) prefetched
    expect(itemCalls().every((p) => p.get('page_size') === '100')).toBe(true)
    fireEvent.click(screen.getAllByRole('button', { name: 'Next page' })[0])
    expect(nav.replace).toHaveBeenLastCalledWith(`/import/leads?list=${L3}&page=3`, { scroll: false })
    fireEvent.click(screen.getAllByRole('button', { name: 'Last page' })[0])
    expect(nav.replace).toHaveBeenLastCalledWith(`/import/leads?list=${L3}&page=44`, { scroll: false })
    fireEvent.keyDown(screen.getByRole('region', { name: 'Big table' }), { key: 'ArrowLeft' })
    expect(nav.replace).toHaveBeenLastCalledWith(`/import/leads?list=${L3}&page=1`, { scroll: false })
    // While a cell is being edited the arrows move the caret, not the page.
    fireEvent.click(within(table).getByRole('button', { name: 'Edit title, row 101' }))
    nav.replace.mockClear()
    fireEvent.keyDown(within(table).getByRole('textbox', { name: 'title, row 101' }), { key: 'ArrowRight' })
    expect(nav.replace).not.toHaveBeenCalled()
  })

  it('the first page disables First / Previous', async () => {
    folders = [{ id: null, name: 'Unfiled', lists: [list(L3, 'Big', { item_count: 4312 })] }]
    nav.params = new URLSearchParams(`list=${L3}`)
    fresh()
    await screen.findByText('Rows 1–100 of 4,312 · page 1 of 44', undefined, { timeout: 3000 }).catch(() => null)
    const first = (await screen.findAllByRole('button', { name: 'First page' }))[0] as HTMLButtonElement
    expect(first.disabled).toBe(true)
    expect((screen.getAllByRole('button', { name: 'Previous page' })[0] as HTMLButtonElement).disabled).toBe(true)
  })

  it('an influencer candidate sheet sits in the Influencers folder and opens as the candidate review', async () => {
    const SH = '55555555-5555-4555-8555-555555555555'
    folders = [{ id: null, kind: 'influencers', name: 'Influencers', lists: [list(SH, 'PM Influencers', { item_count: 133, sheet_kind: 'influencer_candidates', influencer_batch_id: 'c3a7b8cc-b009-450f-9bf6-3d129e2a06fc' })] }]
    nav.params = new URLSearchParams(`list=${SH}`)
    fresh()
    const tree = await screen.findByRole('navigation', { name: 'Lead lists' })
    expect(within(tree).getByText(/133 candidates/)).toBeTruthy()
    expect(within(tree).queryByRole('button', { name: 'New list in Influencers' })).toBeNull()
    await waitFor(() => expect(calls.some((c) => c.url === '/api/influencers/candidates/c3a7b8cc-b009-450f-9bf6-3d129e2a06fc')).toBe(true))
    expect(screen.queryByRole('button', { name: 'Send to validator' })).toBeNull()
  })
})
