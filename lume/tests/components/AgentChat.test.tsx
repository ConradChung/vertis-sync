// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/agent',
  useSearchParams: () => nav.params,
}))

import { AgentChat, SUGGESTIONS } from '@/components/agent/AgentChat'
import { Markdown } from '@/components/agent/Markdown'

beforeEach(() => {
  nav.params = new URLSearchParams()
  nav.push.mockReset()
  nav.replace.mockReset()
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView = () => {}
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const CONV = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const today = new Date().toISOString()

/** Route fetches by URL: the history list, one conversation, or the run. */
function router(handlers: {
  list?: () => Response
  conversation?: () => Response
  run?: () => Response
  other?: (url: string, init?: RequestInit) => Response
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/agent/conversations') return handlers.list?.() ?? Response.json({ conversations: [] })
    if (url === '/api/agent/run') return handlers.run?.() ?? Response.json({ error: 'x' }, { status: 500 })
    if (url.startsWith('/api/agent/conversations/') && (!init?.method || init.method === 'GET'))
      return handlers.conversation?.() ?? Response.json({ error: 'not_found' }, { status: 404 })
    return handlers.other?.(url, init) ?? Response.json({ ok: true })
  })
}

function sseResponse(frames: object[]) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder()
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
      c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

describe('AgentChat', () => {
  it('shows the greeting and suggestion chips when empty', () => {
    vi.stubGlobal('fetch', router({}))
    render(<AgentChat />)
    for (const s of SUGGESTIONS) expect(screen.getByRole('button', { name: s })).toBeTruthy()
    expect(screen.getByLabelText('Message Lume')).toBeTruthy()
  })

  it('streams a reply with tool chips and an approval card', async () => {
    const fetchMock = router({
      run: () =>
        sseResponse([
          { type: 'run', id: 'r1', conversation_id: CONV },
          { type: 'tool_start', id: 't1', name: 'list_gates', tier: 'read' },
          { type: 'tool_end', id: 't1', ok: true, ms: 300 },
          { type: 'text', delta: 'Two gates are **waiting**:\n\n- Order A\n- Order B' },
          { type: 'approval', action_id: 'abc', summary: 'Open gate A', tool: 'open_gate' },
          { type: 'done' },
        ]),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentChat />)
    const box = screen.getByLabelText('Message Lume')
    fireEvent.change(box, { target: { value: "What's waiting on me?" } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await screen.findByText('waiting')
    expect(screen.getByText('Order B').tagName).toBe('LI')
    expect(screen.getByText(/Used 1 tool/)).toBeTruthy()
    // Decided right in the chat: Approve / Deny, with the action page one link away.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Details' }).getAttribute('href')).toBe('/actions/abc')
    const runCall = fetchMock.mock.calls.find((c) => c[0] === '/api/agent/run')!
    // A new chat sends only the message: the server owns history.
    expect(JSON.parse(runCall[1]!.body as string)).toEqual({ prompt: "What's waiting on me?" })
    // The server's conversation id lands in the URL without a reload.
    expect(nav.replace).toHaveBeenCalledWith(`/agent?c=${CONV}`, { scroll: false })
  })

  it('approving in the chat sends an automatic follow-up turn, shown as a muted line', async () => {
    let runs = 0
    const fetchMock = router({
      run: () =>
        runs++ === 0
          ? sseResponse([
              { type: 'run', id: 'r1', conversation_id: CONV },
              { type: 'approval', action_id: 'abc', summary: 'Pause A', tool: 'pause_campaign', state: 'awaiting' },
              { type: 'done' },
            ])
          : sseResponse([{ type: 'text', delta: 'Paused, carrying on.' }, { type: 'done' }]),
      other: (url) => (url === '/api/actions/abc/decide' ? Response.json({ ok: true, status: 'executed', result: {}, error: null }) : Response.json({ ok: true })),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentChat />)
    fireEvent.click(screen.getByRole('button', { name: SUGGESTIONS[0] }))
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await screen.findByText('Paused, carrying on.')
    const bodies = fetchMock.mock.calls.filter((c) => c[0] === '/api/agent/run').map((c) => JSON.parse(c[1]!.body as string))
    expect(bodies[1]).toEqual({ prompt: '[approval] I approved pause_campaign (Pause A). Outcome: executed. Continue.', conversation_id: CONV, auto: true })
    expect(screen.getByLabelText('Approval outcome sent to Lume').textContent).toBe('I approved pause_campaign (Pause A). Outcome: executed. Continue.')
    expect(screen.getByText('Executed')).toBeTruthy()
  })

  it('skip permissions: the toggle shows a banner and sends the flag; a new chat turns it off', async () => {
    const fetchMock = router({ run: () => sseResponse([{ type: 'run', id: 'r1', conversation_id: CONV }, { type: 'text', delta: 'Ok.' }, { type: 'done' }]) })
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentChat />)
    const toggle = screen.getByRole('button', { name: 'Skip permissions' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/Skip permissions is on/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: SUGGESTIONS[0] }))
    await screen.findByText('Ok.')
    const body = JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/api/agent/run')![1]!.body as string)
    expect(body).toEqual({ prompt: SUGGESTIONS[0], skip_permissions: true })
    await waitFor(() => expect((screen.getByLabelText('Message Lume') as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.click(screen.getAllByRole('button', { name: /New chat/ })[0])
    expect(screen.getByRole('button', { name: 'Skip permissions' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByText(/Skip permissions is on/)).toBeNull()
  })

  it('skip permissions changes the composer hint', () => {
    vi.stubGlobal('fetch', router({}))
    render(<AgentChat />)
    expect(screen.getByText('Anything risky waits for your approval')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Skip permissions' }))
    expect(screen.queryByText('Anything risky waits for your approval')).toBeNull()
    expect(screen.getByText('Skip permissions on — money and emails still ask')).toBeTruthy()
  })

  it('the banner turns skip permissions off', () => {
    vi.stubGlobal('fetch', router({}))
    render(<AgentChat />)
    fireEvent.click(screen.getByRole('button', { name: 'Skip permissions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(screen.getByRole('button', { name: 'Skip permissions' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('Shift+Enter does not send', () => {
    const fetchMock = router({})
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentChat />)
    const box = screen.getByLabelText('Message Lume')
    fireEvent.change(box, { target: { value: 'line one' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/agent/run')).toBe(false)
  })

  it('shows an inline notice when the agent is not configured', async () => {
    vi.stubGlobal('fetch', router({ run: () => Response.json({ error: 'agent_not_configured', message: 'ANTHROPIC_API_KEY is not set.' }, { status: 503 }) }))
    render(<AgentChat />)
    fireEvent.click(screen.getByRole('button', { name: SUGGESTIONS[0] }))
    await screen.findByText(/isn.t set up yet/)
    await waitFor(() => expect((screen.getByLabelText('Message Lume') as HTMLTextAreaElement).disabled).toBe(false))
  })

  it('/ focuses the composer when nothing else is focused', () => {
    vi.stubGlobal('fetch', router({}))
    render(<AgentChat />)
    fireEvent.keyDown(window, { key: '/' })
    expect(document.activeElement).toBe(screen.getByLabelText('Message Lume'))
  })
})

describe('AgentChat history', () => {
  const list = () =>
    Response.json({
      conversations: [
        { id: CONV, title: 'Gates today', created_at: today, updated_at: today },
        { id: '11111111-2222-4333-8444-555555555555', title: 'Old rules chat', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
      ],
    })

  it('lists conversations grouped by date and opens one via ?c=', async () => {
    vi.stubGlobal('fetch', router({ list }))
    render(<AgentChat />)
    const nav_ = screen.getAllByRole('navigation', { name: 'Chat history' })[0]
    await within(nav_).findByText('Gates today')
    expect(within(nav_).getByText('Today')).toBeTruthy()
    expect(within(nav_).getByText('Older')).toBeTruthy()
    fireEvent.click(within(nav_).getByRole('button', { name: 'Old rules chat' }))
    expect(nav.push).toHaveBeenCalledWith('/agent?c=11111111-2222-4333-8444-555555555555', { scroll: false })
  })

  it('?c= loads the stored turns, tool log and approval card, and sends the conversation id', async () => {
    nav.params = new URLSearchParams({ c: CONV })
    const fetchMock = router({
      list,
      conversation: () =>
        Response.json({
          conversation: { id: CONV, title: 'Gates today' },
          messages: [
            { id: 'm1', conversation_id: CONV, role: 'user', text: 'pause A', tools: [], approvals: [], error: null, run_id: 'r1', created_at: today },
            {
              id: 'm2',
              conversation_id: CONV,
              role: 'assistant',
              text: 'Filed for **approval**.',
              tools: [{ id: 't1', name: 'pause_campaign', tier: 'high', status: 'awaiting', ms: 120 }],
              approvals: [{ action_id: 'act9', deep_link: '/actions/act9', summary: 'Pause A', tool: 'pause_campaign' }],
              error: null,
              run_id: 'r1',
              created_at: today,
            },
          ],
        }),
      run: () => sseResponse([{ type: 'run', id: 'r2', conversation_id: CONV }, { type: 'text', delta: 'B too.' }, { type: 'done' }]),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentChat />)
    await screen.findByText('approval')
    expect(screen.getByText('pause A')).toBeTruthy()
    expect(screen.getByText(/Used 1 tool/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Details' }).getAttribute('href')).toBe('/actions/act9')
    const active = await screen.findAllByRole('button', { name: 'Gates today' })
    expect(active[0].getAttribute('aria-current')).toBe('page')

    const box = screen.getByLabelText('Message Lume')
    fireEvent.change(box, { target: { value: 'and B?' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await screen.findByText('B too.')
    const runCall = fetchMock.mock.calls.find((c) => c[0] === '/api/agent/run')!
    expect(JSON.parse(runCall[1]!.body as string)).toEqual({ prompt: 'and B?', conversation_id: CONV })
    // Same conversation: no URL change, no reload of the stored turns.
    expect(nav.replace).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.filter((c) => c[0] === `/api/agent/conversations/${CONV}`)).toHaveLength(1)
  })

  it('a missing conversation shows a notice with a way out', async () => {
    nav.params = new URLSearchParams({ c: CONV })
    vi.stubGlobal('fetch', router({}))
    render(<AgentChat />)
    await screen.findByText(/This chat isn.t here/)
    fireEvent.click(screen.getByRole('button', { name: 'Start a new chat' }))
    expect(nav.push).toHaveBeenCalledWith('/agent', { scroll: false })
  })

  it('delete asks first, then soft-deletes', async () => {
    const fetchMock = router({ list })
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentChat />)
    const nav_ = screen.getAllByRole('navigation', { name: 'Chat history' })[0]
    await within(nav_).findByText('Gates today')
    fireEvent.click(within(nav_).getByRole('button', { name: 'Options for Gates today' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }))
    await screen.findByText('Delete this chat?')
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === `/api/agent/conversations/${CONV}` && c[1]?.method === 'DELETE')).toBe(true))
    await waitFor(() => expect(within(nav_).queryByText('Gates today')).toBeNull())
  })
})

describe('Markdown', () => {
  it('renders code fences and drops unsafe links', () => {
    const { container } = render(<Markdown text={'See [x](javascript:alert(1)) and [y](/actions/1)\n\n```\nconst a = 1\n```'} />)
    expect(container.querySelector('pre code')?.textContent).toBe('const a = 1')
    const links = [...container.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/actions/1'])
  })
})
