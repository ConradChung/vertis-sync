// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { approvalFollowUp, storedToChat, useAgentChat } from '@/hooks/useAgentChat'
import type { ApprovalDecision } from '@/components/agent/ApprovalCard'
import type { StoredMessage } from '@/lib/agent/history'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function sse(frames: object[]) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder()
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
      c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const runBodies = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter((c) => c[0] === '/api/agent/run').map((c) => JSON.parse((c[1] as RequestInit).body as string))

const approved: ApprovalDecision = { action_id: 'act1', tool: 'pause_campaign', summary: 'Pause A', decision: 'approve', status: 'executed', error: null }

describe('approvalFollowUp', () => {
  it('approve reports the outcome (and any error); deny says not to retry', () => {
    expect(approvalFollowUp(approved)).toBe('[approval] I approved pause_campaign (Pause A). Outcome: executed. Continue.')
    expect(approvalFollowUp({ ...approved, status: 'failed', error: 'boom' })).toBe(
      '[approval] I approved pause_campaign (Pause A). Outcome: failed — boom. Continue.'
    )
    expect(approvalFollowUp({ ...approved, decision: 'reject', status: 'rejected', summary: null })).toBe(
      "[approval] I denied pause_campaign (). Don't retry it; tell me what you'd do instead."
    )
  })
})

describe('useAgentChat', () => {
  it('an auto turn says so in the request body and on the message', async () => {
    const fetchMock = vi.fn(async () => sse([{ type: 'done' }]))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAgentChat())
    await act(() => result.current.send('[approval] I approved x (). Outcome: executed. Continue.', undefined, { auto: true }))
    expect(runBodies(fetchMock)[0]).toEqual({ prompt: '[approval] I approved x (). Outcome: executed. Continue.', auto: true })
    expect(result.current.messages[0]).toMatchObject({ role: 'user', auto: true })
  })

  it('a follow-up during a live run waits for it to settle, once per action', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) await gate
      return sse([{ type: 'done' }])
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAgentChat())
    let first!: Promise<void>
    act(() => {
      first = result.current.send('pause A')
    })
    await waitFor(() => expect(result.current.busy).toBe(true))
    act(() => {
      result.current.followUp(approved)
      result.current.followUp(approved)
    })
    expect(runBodies(fetchMock)).toHaveLength(1)
    release()
    await act(() => first)
    await waitFor(() => expect(runBodies(fetchMock)).toHaveLength(2))
    expect(runBodies(fetchMock)[1]).toEqual({ prompt: approvalFollowUp(approved), auto: true })
    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(runBodies(fetchMock)).toHaveLength(2)
  })

  it('an idle follow-up is sent at once', async () => {
    const fetchMock = vi.fn(async () => sse([{ type: 'done' }]))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAgentChat())
    act(() => result.current.followUp({ ...approved, decision: 'reject', status: 'rejected' }))
    await waitFor(() => expect(runBodies(fetchMock)).toHaveLength(1))
    expect(runBodies(fetchMock)[0]).toMatchObject({ auto: true, prompt: expect.stringContaining('I denied pause_campaign') })
  })
})

describe('storedToChat', () => {
  it('keeps auto, and approvals with their state and live status', () => {
    const m = storedToChat({
      id: 'm1',
      conversation_id: 'c',
      role: 'user',
      text: '[approval] …',
      tools: [],
      approvals: [{ action_id: 'a', deep_link: '/actions/a', summary: null, tool: 't', state: 'awaiting', status: 'executed' }],
      error: null,
      run_id: null,
      auto: true,
      created_at: '',
    } as StoredMessage)
    expect(m.auto).toBe(true)
    expect(m.approvals[0]).toMatchObject({ state: 'awaiting', status: 'executed' })
    expect(storedToChat({ id: 'm2', role: 'user', text: 'hi', tools: [], approvals: [], auto: false } as unknown as StoredMessage)).not.toHaveProperty('auto')
  })
})

describe('skip permissions', () => {
  it('rides on every send while on, including auto follow-ups, and a new chat clears it', async () => {
    const fetchMock = vi.fn(async () => sse([{ type: 'run', id: 'r', conversation_id: 'c1' }, { type: 'done' }]))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAgentChat())
    expect(result.current.skipPermissions).toBe(false)
    act(() => result.current.setSkipPermissions(true))
    await act(() => result.current.send('pause A'))
    await act(async () => result.current.followUp(approved))
    await waitFor(() => expect(runBodies(fetchMock)).toHaveLength(2))
    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(runBodies(fetchMock)[0]).toEqual({ prompt: 'pause A', skip_permissions: true })
    expect(runBodies(fetchMock)[1]).toMatchObject({ auto: true, skip_permissions: true })
    act(() => result.current.reset())
    expect(result.current.skipPermissions).toBe(false)
    await act(() => result.current.send('again'))
    expect(runBodies(fetchMock)[2]).toEqual({ prompt: 'again' })
  })

  it('switching conversations turns it off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ messages: [] })))
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useAgentChat({ conversationId: id }), { initialProps: { id: null as string | null } })
    act(() => result.current.setSkipPermissions(true))
    rerender({ id: '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c' })
    expect(result.current.skipPermissions).toBe(false)
  })
})
