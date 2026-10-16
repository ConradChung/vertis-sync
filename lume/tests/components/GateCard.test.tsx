// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { GATE_KINDS, type GateKind, type GateRow } from '@/lib/db/types'
import { BUTTON_SPECS } from '@/lib/validate/actions'
import { GateCard } from '@/components/validate/GateCard'
import { GateList } from '@/components/validate/GateList'

afterEach(cleanup)

const ID = '7db3d841-252c-4572-95ec-bc110727df8d'
const gate = (kind: GateKind, o: Partial<GateRow> = {}): GateRow => ({
  kind,
  target_table: 'validation_jobs',
  target_id: ID,
  title: `title ${kind}`,
  subtitle: 'sub',
  actions: [],
  counts: {},
  telegram_message_id: null,
  created_at: new Date().toISOString(),
  ...o,
})

describe('GateCard', () => {
  it.each(GATE_KINDS)('%s renders its buttons', (kind) => {
    render(<GateCard gate={gate(kind)} focused={false} busy={false} onAction={() => {}} />)
    for (const s of BUTTON_SPECS[kind]) expect(screen.getByRole('button', { name: s.label })).toBeTruthy()
  })

  it('ingest_approval with no email column shows Deny only', () => {
    render(<GateCard gate={gate('ingest_approval', { actions: ['deny'] })} focused={false} busy={false} onAction={() => {}} />)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Deny'])
  })

  it('reject-like buttons use the red (destructive) tone', () => {
    render(<GateCard gate={gate('jobs_review')} focused={false} busy={false} onAction={() => {}} />)
    const skip = screen.getByRole('button', { name: 'Skip' })
    const pull = screen.getByRole('button', { name: 'Reviewed, pull' })
    expect(skip.getAttribute('data-tone')).toBe('reject')
    expect(skip.className).toContain('text-destructive')
    expect(pull.className).not.toContain('text-destructive')
  })

  it('disables every button and shows a spinner while a decision is in flight', () => {
    const onAction = vi.fn()
    render(<GateCard gate={gate('jobs_review')} focused busy onAction={onAction} />)
    const card = screen.getByRole('group')
    expect(card.getAttribute('aria-busy')).toBe('true')
    for (const b of within(card).getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('Working')
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('click passes the spec', () => {
    const onAction = vi.fn()
    render(<GateCard gate={gate('jobs_review')} focused busy={false} onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed, pull' }))
    expect(onAction.mock.calls[0][0]).toMatchObject({ action: 'jobs_pull', mode: 'decide' })
  })

  it('roving tabindex and accessible name', () => {
    const { rerender } = render(<GateCard gate={gate('stall')} focused={false} busy={false} onAction={() => {}} />)
    const card = screen.getByRole('group')
    expect(card.getAttribute('tabindex')).toBe('-1')
    expect(card.getAttribute('aria-label')).toBe('Stalled job: title stall — sub')
    rerender(<GateCard gate={gate('stall')} focused busy={false} onAction={() => {}} />)
    expect(card.getAttribute('tabindex')).toBe('0')
  })

  it('lfo_count custom count validates 500–50000 before ordering', () => {
    const onAction = vi.fn()
    render(<GateCard gate={gate('lfo_count')} focused busy={false} countOpen onAction={onAction} />)
    const input = screen.getByLabelText('Contact count')
    const order = () => screen.getByRole('button', { name: /^Order/ }) as HTMLButtonElement
    fireEvent.change(input, { target: { value: '499' } })
    expect(order().disabled).toBe(true)
    fireEvent.change(input, { target: { value: '50001' } })
    expect(order().disabled).toBe(true)
    fireEvent.change(input, { target: { value: '1500' } })
    expect(order().disabled).toBe(false)
    fireEvent.click(order())
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ needsCount: true }), 1500)
  })

  it('a blocked action is disabled with its reason (Push these with 0 eligible)', () => {
    render(
      <GateCard gate={gate('push_review')} focused busy={false} onAction={() => {}} blocked={{ push_to_instantly: 'Nothing to push' }} />
    )
    expect((screen.getByRole('button', { name: 'Push these' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Cancel push' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText('Nothing to push')).toBeTruthy()
  })

  it('lume_action links to the action page', () => {
    render(<GateCard gate={gate('lume_action', { target_table: 'pending_actions' })} focused busy={false} onAction={() => {}} />)
    expect(screen.getByRole('link', { name: /Details/ }).getAttribute('href')).toBe(`/actions/${ID}`)
  })
})

describe('GateList', () => {
  it('groups by kind with a count header, in pipeline order', () => {
    const gates = [
      gate('jobs_review', { target_id: '22cc8b72-5e8b-43de-90c8-4e4b8021755a', target_table: 'job_batches' }),
      gate('campaign_choice'),
      gate('jobs_review', { target_id: '33cc8b72-5e8b-43de-90c8-4e4b8021755a', target_table: 'job_batches' }),
    ]
    const { container } = render(
      <GateList gates={gates} focusedKey={`campaign_choice:${ID}`} busyKeys={new Set()} onAction={() => {}} onFocusGate={() => {}} />
    )
    const sections = [...container.querySelectorAll('section[data-group]')]
    expect(sections.map((s) => s.getAttribute('data-group'))).toEqual(['campaign_choice', 'jobs_review'])
    const headers = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headers).toEqual(['Pick a campaign1', 'Job scrape review2'])
    expect(within(sections[1] as HTMLElement).getAllByRole('group')).toHaveLength(2)
    // Only the focused card is tabbable.
    expect(container.querySelectorAll('[role="group"][tabindex="0"]')).toHaveLength(1)
  })
})
