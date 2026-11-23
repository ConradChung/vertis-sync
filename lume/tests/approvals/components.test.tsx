// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark', setTheme: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))

import { NavBadge } from '@/components/shell/NavBadge'
import { MobileNav } from '@/components/shell/MobileNav'
import { ApprovalRow } from '@/components/approvals/ApprovalsList'
import { ActionPlan, type ActionView } from '@/components/actions/ActionPlan'
import { PendingCheck, Quote } from '@/components/progress/IcpCheck'
import type { CheckOverview } from '@/lib/companyCheck/action'
import type { ApprovalItem } from '@/lib/approvals/view'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('NavBadge', () => {
  it('hidden at 0, shows the count otherwise', () => {
    const { container, rerender } = render(<NavBadge count={0} />)
    expect(container.querySelector('[data-nav-badge]')).toBeNull()
    rerender(<NavBadge count={4} />)
    expect(container.querySelector('[data-nav-badge]')?.textContent).toBe('4 waiting for approval')
  })

  it('phone: on More and on Approvals in the sheet; none at 0', () => {
    const { container, rerender } = render(<MobileNav pathname="/overview" warm={vi.fn()} pending={0} />)
    expect(container.querySelector('[data-nav-badge]')).toBeNull()
    rerender(<MobileNav pathname="/overview" warm={vi.fn()} pending={3} />)
    const bar = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(bar).getByRole('button', { name: /More/ }).textContent).toContain('3')
    fireEvent.click(within(bar).getByRole('button', { name: /More/ }))
    expect(screen.getByRole('link', { name: /Approvals/ }).textContent).toContain('3 waiting for approval')
  })
})

const item = (o: Partial<ApprovalItem> = {}): ApprovalItem => ({
  id: 'a1',
  kind: 'company_check',
  label: 'ICP check',
  summary: 'Check 500 companies',
  cap_usd: 3.89,
  estimate_usd: 3.53,
  requested_by: 'agent',
  created_at: '2026-11-23T10:00:00Z',
  notify_warning: 'Telegram not sent: missing token',
  open_only: false,
  ...o,
})

describe('ApprovalRow', () => {
  it('shows summary, cap, warning, Open and decides through the decide route', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'rejected' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const onDecided = vi.fn()
    render(<ApprovalRow item={item()} now={new Date('2026-11-23T10:05:00Z')} onDecided={onDecided} />)
    expect(screen.getByText('Check 500 companies')).toBeTruthy()
    expect(screen.getByText('cap $3.89')).toBeTruthy()
    expect(screen.getByText('Telegram not sent: missing token')).toBeTruthy()
    expect(screen.getByText(/5 min/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/actions/a1')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(fetch).toHaveBeenCalledWith('/api/actions/a1/decide', expect.objectContaining({ method: 'POST', body: JSON.stringify({ decision: 'reject' }) }))
  })

  it('no warning when notify was fine; open-only kinds have no inline buttons', () => {
    render(<ApprovalRow item={item({ notify_warning: null, open_only: true })} />)
    expect(screen.queryByText(/Telegram not sent/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })
})

describe('ActionPlan notify warning', () => {
  const view = (o: Partial<ActionView> = {}): ActionView => ({
    id: 'a1', kind: 'company_check', summary: 's', details: [], requestedBy: 'agent', status: 'awaiting',
    decidedVia: null, decidedAt: null, executedAt: null, createdAt: '2026-11-23T10:00:00Z', error: null, ...o,
  })
  it('shows it when set, nothing otherwise', () => {
    const { rerender } = render(<ActionPlan action={view({ notifyWarning: 'Telegram not sent: missing token' })} />)
    expect(screen.getByText('Telegram not sent: missing token')).toBeTruthy()
    rerender(<ActionPlan action={view({ notifyWarning: null })} />)
    expect(screen.queryByText(/Telegram not sent/)).toBeNull()
  })
})

describe('ICP check pending-action box', () => {
  it('labels the filed action apart from the live quote, with its own cap', () => {
    render(
      <PendingCheck
        gate={{ target_id: 'a9', created_at: '2026-11-23T10:00:00Z', counts: { icp: 'Residential PMs', scope: 'all', companies: 500, estimate_usd: 3.53, max_usd: 3.89 } }}
      />
    )
    const box = screen.getByRole('group', { name: 'Pending action' })
    expect(within(box).getByText('Pending action')).toBeTruthy()
    expect(within(box).getByText('Residential PMs')).toBeTruthy()
    expect(within(box).getByText('All valid leads')).toBeTruthy()
    expect(within(box).getByText('$3.89')).toBeTruthy()
    expect(within(box).getByText('$3.53')).toBeTruthy()
    expect(within(box).getByText(/filed Nov 23, 2026/)).toBeTruthy()
    expect(within(box).getByRole('link', { name: 'open the action' }).getAttribute('href')).toBe('/actions/a9')
  })
})

describe('ICP check live quote', () => {
  it('is labelled "New request estimate", its cap named for a new request', () => {
    const o = {
      scope: 'all',
      plan: { valid_leads: 800, all_valid_leads: 800, companies: 520, cached: 20 },
      unchecked: 500,
      estimate: { usd: 3.53, unit_usd: 0.00706, per_lead_usd: 0.0044, default_cap_usd: 3.89 },
      notes: [],
    } as unknown as CheckOverview
    render(<Quote o={o} error={null} stale={false} />)
    const box = screen.getByRole('group', { name: 'New request estimate' })
    expect(within(box).getByText('New request estimate')).toBeTruthy()
    expect(within(box).getByText('Hard cap (new request)')).toBeTruthy()
    expect(within(box).queryByText('Pending action')).toBeNull()
  })
})
