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
const list = (id: string, name: string, o: Record<string, unknown> = {}) => ({
  id, name, notes: null, created_by: 'agent', project_id: null, project_default: false, item_count: 120, email_count: 80,
  sent_ingest_id: null, sent_at: null, sent_rows: null, sent_job_id: null, created_at: '2026-11-05T00:00:00Z', updated_at: new Date().toISOString(), ...o,
})
let folders: unknown[] = []
const calls: { url: string; method: string; body?: unknown }[] = []
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
  if (url === '/api/lead-lists') return Response.json({ folders })
  if (url.startsWith(`/api/lead-lists/${L1}/items?`)) {
    return Response.json({ rows: [{ idx: 0, item: { name: 'Acme', first_name: 'Jane', last_name: 'Doe', email: 'jane@acme.co', company: 'Acme' }, source: 'agent' }, { idx: 1, item: { name: 'Beta', email: null, company: 'Beta' }, source: 'manual' }], total: 2, page: 0, page_size: 50 })
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
    expect((screen.getByText('Roofers TX', { selector: 'summary *' }).closest('details') as HTMLDetailsElement).open).toBe(true)
  })

  it('edits a cell inline (PATCH the one field)', async () => {
    nav.params = new URLSearchParams(`list=${L1}`)
    fresh()
    const table = await screen.findByRole('table', { name: 'Roofers TX rows' })
    await within(table).findByText('jane@acme.co')
    fireEvent.click(within(table).getByRole('button', { name: 'Edit Email, row 2' }))
    const input = within(table).getByRole('textbox', { name: 'Email, row 2' })
    fireEvent.change(input, { target: { value: 'b@beta.co' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toEqual({ url: `/api/lead-lists/${L1}/items/1`, method: 'PATCH', body: { email: 'b@beta.co' } }))
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
})
