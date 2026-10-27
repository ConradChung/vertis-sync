// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApprovalCard, type ChatApproval } from '@/components/agent/ApprovalCard'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const A: ChatApproval = { action_id: 'act1', deep_link: '/actions/act1', summary: 'Pause campaign A\n120 leads', tool: 'pause_campaign' }

function stubDecide(res: Response) {
  const fetchMock = vi.fn(async () => res)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('ApprovalCard', () => {
  it('awaiting: summary, tool, Approve / Deny and a Details link', () => {
    render(<ApprovalCard approvals={[A]} />)
    expect(screen.getByText(/Pause campaign A/)).toBeTruthy()
    expect(screen.getByText('pause_campaign')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Details' }).getAttribute('href')).toBe('/actions/act1')
  })

  it('approve posts the decision, settles with the outcome and reports it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetchMock = vi.fn(async () => {
      await gate
      return Response.json({ ok: true, status: 'executed', result: {}, error: null })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onDecided = vi.fn()
    render(<ApprovalCard approvals={[A]} onDecided={onDecided} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    // In flight: both buttons are disabled.
    await waitFor(() => expect((screen.getByRole('button', { name: /Approv/ }) as HTMLButtonElement).disabled).toBe(true))
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true)
    release()
    await screen.findByText('Executed')
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/actions/act1/decide', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual({ decision: 'approve' })
    expect(onDecided).toHaveBeenCalledWith({ action_id: 'act1', tool: 'pause_campaign', summary: A.summary, decision: 'approve', status: 'executed', error: null })
  })

  it('a failed run after approval carries its error', async () => {
    stubDecide(Response.json({ ok: false, status: 'failed', result: {}, error: 'Instantly 500' }))
    const onDecided = vi.fn()
    render(<ApprovalCard approvals={[A]} onDecided={onDecided} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Failed')
    expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approve', status: 'failed', error: 'Instantly 500' }))
  })

  it('deny settles as rejected', async () => {
    const fetchMock = stubDecide(Response.json({ ok: true, status: 'rejected' }))
    const onDecided = vi.fn()
    render(<ApprovalCard approvals={[A]} onDecided={onDecided} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await screen.findByText('Denied')
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual({ decision: 'reject' })
    expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ decision: 'reject', status: 'rejected' }))
  })

  it('409 already_handled shows who won and still reports it', async () => {
    stubDecide(Response.json({ error: 'already_handled', status: 'executed' }, { status: 409 }))
    const onDecided = vi.fn()
    render(<ApprovalCard approvals={[A]} onDecided={onDecided} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Already executed elsewhere')
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approve', status: 'executed' }))
  })

  it('other errors show the text and re-enable the buttons', async () => {
    stubDecide(Response.json({ error: 'internal' }, { status: 500 }))
    const onDecided = vi.fn()
    render(<ApprovalCard approvals={[A]} onDecided={onDecided} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByRole('alert')
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false)
    expect(onDecided).not.toHaveBeenCalled()
  })

  it('skip-mode states render a compact line with no buttons', () => {
    render(
      <ApprovalCard
        approvals={[
          { ...A, action_id: 'x1', deep_link: '/actions/x1', summary: 'Paused A', state: 'auto_executed' },
          { ...A, action_id: 'x2', deep_link: '/actions/x2', summary: 'Paused B', state: 'auto_failed' },
          { ...A, action_id: 'x3', deep_link: '/actions/x3', summary: 'Paused C', state: 'handled_elsewhere', status: 'rejected' },
        ]}
      />
    )
    expect(screen.getByText(/Ran without asking \(skip mode\): Paused A/)).toBeTruthy()
    expect(screen.getByText(/failed/i, { selector: '[data-state="auto_failed"] *' })).toBeTruthy()
    expect(screen.getByText(/Handled elsewhere: denied/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getAllByRole('link', { name: 'Details' }).map((l) => l.getAttribute('href'))).toEqual(['/actions/x1', '/actions/x2', '/actions/x3'])
  })

  it('a reloaded approval that already ran shows its status, not buttons', () => {
    render(<ApprovalCard approvals={[{ ...A, state: 'awaiting', status: 'executed' }]} />)
    expect(screen.getByText('Executed')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('a reloaded approval still awaiting keeps its buttons', () => {
    render(<ApprovalCard approvals={[{ ...A, state: 'awaiting', status: 'awaiting' }]} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
  })
})
