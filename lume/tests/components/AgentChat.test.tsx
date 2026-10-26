// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentChat, SUGGESTIONS } from '@/components/agent/AgentChat'
import { Markdown } from '@/components/agent/Markdown'

beforeEach(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView = () => {}
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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
    render(<AgentChat />)
    for (const s of SUGGESTIONS) expect(screen.getByRole('button', { name: s })).toBeTruthy()
    expect(screen.getByLabelText('Message Lume')).toBeTruthy()
  })

  it('streams a reply with tool chips and an approval card', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { type: 'run', id: 'r1' },
        { type: 'tool_start', id: 't1', name: 'list_gates', tier: 'read' },
        { type: 'tool_end', id: 't1', ok: true, ms: 300 },
        { type: 'text', delta: 'Two gates are **waiting**:\n\n- Order A\n- Order B' },
        { type: 'approval', action_id: 'abc', summary: 'Open gate A', tool: 'open_gate' },
        { type: 'done' },
      ])
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentChat />)
    const box = screen.getByLabelText('Message Lume')
    fireEvent.change(box, { target: { value: "What's waiting on me?" } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await screen.findByText('waiting')
    expect(screen.getByText('Order B').tagName).toBe('LI')
    expect(screen.getByText(/Used 1 tool/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Review' }).getAttribute('href')).toBe('/actions/abc')
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ prompt: "What's waiting on me?" })
  })

  it('Shift+Enter does not send', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentChat />)
    const box = screen.getByLabelText('Message Lume')
    fireEvent.change(box, { target: { value: 'line one' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows an inline notice when the agent is not configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'agent_not_configured', message: 'ANTHROPIC_API_KEY is not set.' }, { status: 503 }))
    )
    render(<AgentChat />)
    fireEvent.click(screen.getByRole('button', { name: SUGGESTIONS[0] }))
    await screen.findByText(/isn.t set up yet/)
    await waitFor(() => expect((screen.getByLabelText('Message Lume') as HTMLTextAreaElement).disabled).toBe(false))
  })

  it('/ focuses the composer when nothing else is focused', () => {
    render(<AgentChat />)
    fireEvent.keyDown(window, { key: '/' })
    expect(document.activeElement).toBe(screen.getByLabelText('Message Lume'))
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
