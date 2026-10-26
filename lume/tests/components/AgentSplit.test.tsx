// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/agent',
  useSearchParams: () => nav.params,
}))
vi.mock('@/components/playground/PlaygroundCanvas', () => ({
  PlaygroundCanvas: ({ diagram, direction }: { diagram: { title?: string }; direction: string }) => (
    <div data-testid="canvas" data-direction={direction}>
      canvas:{diagram.title}
    </div>
  ),
}))

import { AgentChat } from '@/components/agent/AgentChat'
import { directionFor } from '@/components/agent/AgentSidePanel'
import { chatDiagrams } from '@/lib/agent/chatDiagrams'

const CONV = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const SET = '1a2b3c4d-1111-4222-8333-444455556666'
const today = new Date().toISOString()
const flow = (title: string) =>
  '```flow\n' +
  JSON.stringify({ title, nodes: [{ id: 'a', label: 'Scrape', kind: 'source', state: 'planned' }, { id: 'b', label: 'Validate', kind: 'step', state: 'planned' }], edges: [{ from: 'a', to: 'b' }] }) +
  '\n```'

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  nav.params = new URLSearchParams(`c=${CONV}`)
  window.matchMedia = ((q: string) => ({ matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('ResizeObserver', RO)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function serve(opts: { sets?: { id: string; title: string }[]; text?: string; tools?: unknown[] } = {}) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    void _init
    if (url === '/api/agent/conversations') return Response.json({ conversations: [] })
    if (url === '/api/agent/skills') return Response.json({ skills: [] })
    if (url.startsWith('/api/review-sets?')) return Response.json({ sets: opts.sets ?? [] })
    if (url === `/api/review-sets/${SET}`)
      return Response.json({
        set: { id: SET, title: 'Roofers Austin', filters: [{ id: 'f1', label: 'Exclude: no website', changed: 4, action: 'exclude' }] },
        summary: { total: 10, kept: 6, excluded: 4, coverage: { website: 6, phone: 5, email: 0, linkedin: 1 } },
      })
    if (url.startsWith(`/api/review-sets/${SET}/items`))
      return Response.json({
        rows: [{ idx: 0, status: 'kept', excluded_reason: null, filter_id: null, item: { name: 'Acme Roofing', category: 'Roofing contractor', city: 'Austin', state: 'TX', domain: 'acme.com', website: 'acme.com', rating: 4.7, reviews_count: 120, phone: '1', email: null, linkedin_url: null } }],
        total: 1,
      })
    if (url.startsWith('/api/agent/conversations/'))
      return Response.json({
        conversation: { id: CONV, title: 'Plan' },
        messages: [
          { id: 'u1', conversation_id: CONV, role: 'user', text: 'plan it', tools: [], approvals: [], error: null, run_id: 'r', created_at: today },
          { id: 'a1', conversation_id: CONV, role: 'assistant', text: opts.text ?? `First idea\n\n${flow('Plan A')}\n\nThen\n\n${flow('Plan B')}`, tools: opts.tools ?? [], approvals: [], error: null, run_id: 'r', created_at: today },
        ],
      })
    return Response.json({ ok: true })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('chatDiagrams', () => {
  it('finds finished and streaming flow blocks per message', () => {
    const d = chatDiagrams([
      { id: 'm1', role: 'assistant', text: `${flow('A')}\n${flow('B')}` },
      { id: 'm2', role: 'assistant', text: '```flow\n{"title":"C"' },
      { id: 'm3', role: 'user', text: flow('ignored') },
    ])
    expect(d.map((x) => [x.key, x.diagram?.title ?? null, x.streaming])).toEqual([
      ['m1:0', 'A', false],
      ['m1:1', 'B', false],
      ['m2:0', null, true],
    ])
  })

  it('picks the panel direction from its shape', () => {
    expect(directionFor(900, 500)).toBe('LR')
    expect(directionFor(500, 800)).toBe('TB')
  })
})

describe('Agent split screen', () => {
  it('shows chips in the chat and the newest diagram in the side panel', async () => {
    serve()
    render(<AgentChat />)
    const panel = await screen.findByRole('region', { name: 'Pipeline and leads' })
    expect(within(panel).getByTestId('canvas').textContent).toBe('canvas:Plan B')
    const chips = screen.getAllByRole('button', { name: /^Pipeline · / })
    expect(chips).toHaveLength(2)
    expect(chips[1].getAttribute('aria-pressed')).toBe('true')
    // No diagram is drawn inside the chat column itself.
    expect(screen.getAllByTestId('canvas')).toHaveLength(1)
  })

  it('switches diagrams from a chip, closes, and reopens', async () => {
    serve()
    render(<AgentChat />)
    await screen.findByRole('region', { name: 'Pipeline and leads' })
    fireEvent.click(screen.getAllByRole('button', { name: /^Pipeline · / })[0])
    expect(screen.getByTestId('canvas').textContent).toBe('canvas:Plan A')
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(screen.queryByRole('region', { name: 'Pipeline and leads' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Show pipeline/ }))
    expect(await screen.findByRole('region', { name: 'Pipeline and leads' })).toBeTruthy()
  })

  it('opens on the Leads tab when the conversation has a review set', async () => {
    serve({ sets: [{ id: SET, title: 'Roofers Austin' }], text: 'Loaded the results.', tools: [{ id: 't', name: 'load_actor_results', tier: 'low', status: 'ok', ms: 900 }] })
    render(<AgentChat />)
    await screen.findByText('Acme Roofing')
    const panel = screen.getByRole('region', { name: 'Pipeline and leads' })
    expect(within(panel).getByRole('tab', { name: /Leads/ }).getAttribute('aria-selected')).toBe('true')
    expect(within(panel).getByText(/6 kept/)).toBeTruthy()
    expect(within(panel).getByText('Exclude: no website')).toBeTruthy()
    expect(within(panel).getByRole('link', { name: 'Export kept for Apollo' }).getAttribute('href')).toBe(`/api/review-sets/${SET}/export`)
  })

  it('undoes a filter chip and excludes picked rows from the Leads tab', async () => {
    const fetchMock = serve({ sets: [{ id: SET, title: 'Roofers Austin' }], text: 'Loaded.' })
    render(<AgentChat />)
    await screen.findByText('Acme Roofing')
    fireEvent.click(screen.getByRole('button', { name: 'Undo: Exclude: no website' }))
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === `/api/review-sets/${SET}/restore`)).toBe(true))
    const restore = fetchMock.mock.calls.find((c) => c[0] === `/api/review-sets/${SET}/restore`)!
    expect(JSON.parse((restore[1] as RequestInit).body as string)).toEqual({ filter_id: 'f1' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Acme Roofing' }))
    fireEvent.click(await screen.findByRole('button', { name: /Exclude 1/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === `/api/review-sets/${SET}/rows`)).toBe(true))
    const rows = fetchMock.mock.calls.find((c) => c[0] === `/api/review-sets/${SET}/rows`)!
    expect(JSON.parse((rows[1] as RequestInit).body as string)).toEqual({ idxs: [0], status: 'excluded' })
  })
})
