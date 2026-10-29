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

  it('issue_operator_key: the sign-in link from the decide response is shown once, never reported onward', async () => {
    stubDecide(Response.json({ ok: true, status: 'executed', result: { sign_in_url_masked: 'x?k=RAWK****' }, error: null, sign_in_url: 'https://lume.test/auth/operator?k=RAWKEY' }))
    const onDecided = vi.fn()
    render(<ApprovalCard approvals={[{ ...A, tool: 'issue_operator_key' }]} onDecided={onDecided} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    const input = (await screen.findByLabelText('Sign-in link')) as HTMLInputElement
    expect(input.value).toBe('https://lume.test/auth/operator?k=RAWKEY')
    expect(JSON.stringify(onDecided.mock.calls)).not.toContain('RAWKEY')
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
    expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approve', status: 'executed', elsewhere: true }))
  })

  it('a double click sends one decision', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetchMock = vi.fn(async () => {
      await gate
      return Response.json({ ok: true, status: 'executed', result: {}, error: null })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ApprovalCard approvals={[A]} />)
    const approve = screen.getByRole('button', { name: 'Approve' })
    fireEvent.click(approve)
    fireEvent.click(approve)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    release()
    await screen.findByText('Executed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a decision that lands after the card is gone (chat switched) is not reported', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate
        return Response.json({ ok: true, status: 'executed', result: {}, error: null })
      })
    )
    const onDecided = vi.fn()
    const { unmount } = render(<ApprovalCard approvals={[A]} onDecided={onDecided} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    unmount()
    release()
    await new Promise((r) => setTimeout(r, 10))
    expect(onDecided).not.toHaveBeenCalled()
  })

  it('re-syncs when the live status prop changes', () => {
    const { rerender } = render(<ApprovalCard approvals={[{ ...A, state: 'awaiting', status: 'awaiting' }]} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    rerender(<ApprovalCard approvals={[{ ...A, state: 'awaiting', status: 'rejected' }]} />)
    expect(screen.getByText('Denied')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    rerender(<ApprovalCard approvals={[{ ...A, state: 'awaiting', status: 'awaiting' }]} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
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

describe('ApprovalCard: send_reply (inbox manager)', () => {
  const R: ChatApproval = {
    action_id: 'r1', deep_link: '/actions/r1', summary: 'Send reply to ada@acme.com', tool: 'send_reply',
    reply: {
      lead_email: 'ada@acme.com', lead_name: 'Ada Lovelace', company: 'Acme', verdict: 'GOOD', untrusted_text: 'Tuesday works for me.',
      draft: 'Great, Tuesday 10am PT?', proposed_times: ['Tue 10:00 PT', 'Wed 14:00 PT'], research_note: '40 staff', eaccount: 'frank@ours.com', edited_by: null,
    },
  }

  it('shows lead, company, verdict, their message, the draft and the proposed times', () => {
    render(<ApprovalCard approvals={[R]} />)
    expect(screen.getByText('Ada Lovelace <ada@acme.com>')).toBeTruthy()
    expect(screen.getByText('Acme')).toBeTruthy()
    expect(screen.getByText('GOOD')).toBeTruthy()
    expect(screen.getByText('Tuesday works for me.')).toBeTruthy()
    expect(screen.getByText('Great, Tuesday 10am PT?')).toBeTruthy()
    expect(screen.getByText('Tue 10:00 PT · Wed 14:00 PT')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
  })

  it('Edit → change the body → Approve sends the edited body', async () => {
    const fetchMock = stubDecide(Response.json({ ok: true, status: 'executed', result: {}, error: null }))
    render(<ApprovalCard approvals={[R]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const box = screen.getByLabelText('Reply body') as HTMLTextAreaElement
    expect(box.value).toBe('Great, Tuesday 10am PT?')
    fireEvent.change(box, { target: { value: 'Tuesday 11am PT instead?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve edited reply' }))
    await screen.findByText('Executed')
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual({ decision: 'approve', body: 'Tuesday 11am PT instead?' })
  })

  it('Edit then Cancel: a plain approve again', async () => {
    const fetchMock = stubDecide(Response.json({ ok: true, status: 'executed', result: {}, error: null }))
    render(<ApprovalCard approvals={[R]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Executed')
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual({ decision: 'approve' })
  })

  it('an empty edited body cannot be approved', () => {
    render(<ApprovalCard approvals={[R]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Reply body'), { target: { value: '   ' } })
    expect((screen.getByRole('button', { name: 'Approve edited reply' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a settled reply shows its card, no Edit', () => {
    render(<ApprovalCard approvals={[{ ...R, status: 'executed', state: 'awaiting' }]} />)
    expect(screen.getByText('Great, Tuesday 10am PT?')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})
