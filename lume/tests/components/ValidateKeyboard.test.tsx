// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GateKind, GateRow } from '@/lib/db/types'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() }) }))

import { ValidateView } from '@/components/validate/ValidateView'

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
})

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, claimed: true }), { status: 200 }))
beforeEach(() => {
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`
const gate = (kind: GateKind, n: number, table: GateRow['target_table'] = 'job_batches'): GateRow => ({
  kind,
  target_table: table,
  target_id: id(n),
  title: `${kind} ${n}`,
  subtitle: null,
  actions: [],
  counts: {},
  telegram_message_id: null,
  created_at: new Date().toISOString(),
})

const GATES = [gate('jobs_review', 1), gate('jobs_fill', 2), gate('lume_action', 3, 'pending_actions')]
const card = (name: RegExp) => screen.getByRole('group', { name })
const press = async (key: string, target: Element | Window = document.activeElement ?? document.body) => {
  await act(async () => {
    fireEvent.keyDown(target, { key })
    await new Promise((r) => setTimeout(r, 5))
  })
}
const focusOn = async (el: HTMLElement) => {
  await act(async () => {
    el.focus()
  })
}

describe('Validate keyboard', () => {
  it('A with no explicitly focused card does nothing', async () => {
    render(<ValidateView gates={GATES} onRefresh={() => {}} />)
    await press('a', document.body)
    await press('r', document.body)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('A on a focused jobs_review card does nothing (jobs_pull spends: Apollo resolves + a Leadsfriday order)', async () => {
    render(<ValidateView gates={GATES} onRefresh={() => {}} />)
    await focusOn(card(/Job scrape review/))
    await press('a')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('R on a focused jobs_review card decides jobs_skip through /api/gates/decide', async () => {
    render(<ValidateView gates={GATES} onRefresh={() => {}} />)
    await focusOn(card(/Job scrape review/))
    await press('r')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/gates/decide')
    expect(JSON.parse(String(init.body))).toEqual({ callback_data: `jobs_skip:${id(1)}` })
  })

  it('A on jobs_fill (spends) does nothing', async () => {
    render(<ValidateView gates={GATES} onRefresh={() => {}} />)
    await focusOn(card(/Below minimum/))
    await press('a')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('A and R on a lume_action card do nothing (click only)', async () => {
    render(<ValidateView gates={GATES} onRefresh={() => {}} />)
    await focusOn(card(/Needs confirmation/))
    await press('a')
    await press('r')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('A after focus left the list does nothing', async () => {
    render(<ValidateView gates={GATES} onRefresh={() => {}} />)
    await focusOn(card(/Job scrape review/))
    await act(async () => (document.activeElement as HTMLElement).blur())
    await press('a', document.body)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keys typed into an input are ignored', async () => {
    render(
      <>
        <input aria-label="search" />
        <ValidateView gates={GATES} onRefresh={() => {}} />
      </>
    )
    await focusOn(card(/Job scrape review/))
    await focusOn(screen.getByLabelText('search'))
    await press('a')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('J from the page focuses the first card, then moves down', async () => {
    render(<ValidateView gates={GATES} onRefresh={() => {}} />)
    await press('j', document.body)
    await waitFor(() => expect(document.activeElement).toBe(card(/Job scrape review/)))
    await press('j')
    await waitFor(() => expect(document.activeElement).toBe(card(/Below minimum/)))
  })

  it('when the focused gate closes, focus moves to the next card and it is announced', async () => {
    const { rerender } = render(<ValidateView gates={GATES} onRefresh={() => {}} />)
    await focusOn(card(/Job scrape review/))
    await act(async () => {
      rerender(<ValidateView gates={GATES.slice(1)} onRefresh={() => {}} />)
    })
    // Focus lands on the next animation frame.
    await waitFor(() => expect(document.activeElement).toBe(card(/Below minimum/)))
    expect(screen.getByText('Gate closed, 2 remaining')).toBeTruthy()
  })
})
