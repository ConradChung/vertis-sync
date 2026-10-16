// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

// NumberTicker springs from 0 inside an IntersectionObserver; render the value directly.
vi.mock('@/components/ui/number-ticker', () => ({
  NumberTicker: ({ value }: { value: number }) => <span>{value}</span>,
}))

import { KpiTiles, type KpiData } from '@/components/overview/KpiTiles'

afterEach(cleanup)

const base: KpiData = {
  replies_today: 7,
  replies_7d: [2, 3, 2, 5, 4, 5, 7],
  pending_gates: 2,
  gates_opened_7d: [1, 0, 2, 1, 0, 3, 2],
}

const values = () => screen.getAllByTestId('kpi-value').map((n) => n.textContent)

describe('KpiTiles', () => {
  it('renders the four tiles with live Instantly numbers', () => {
    render(
      <KpiTiles
        data={base}
        instantly={{
          configured: true,
          campaign_source: 'lume_campaigns',
          sent_today: 684,
          sent_7d: [600, 610, 590, 640, 620, 650, 684],
          opportunities: 2,
          opportunities_value_usd: 14800,
          opportunities_7d: [0, 0, 1, 0, 0, 1, 0],
          accounts: [],
          campaigns: [],
        }}
      />
    )
    for (const label of ['Sent today', 'Replies today', 'Pending approvals', 'Opportunities']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(values()).toEqual(['684', '7', '2', '2· $14.8K'])
    expect(screen.getByText('+2 from yesterday')).toBeTruthy()
    expect(screen.getByText('Needs attention')).toBeTruthy()
    expect(screen.queryByText(/Instantly not connected/)).toBeNull()
    // Pending approvals jumps to Validate
    // Pending approvals jumps to Validate and announces its value
    expect(screen.getByRole('link', { name: 'Pending approvals: 2. Open Validate' }).getAttribute('href')).toBe('/validate')
    expect(screen.getByRole('img', { name: 'Approvals opened per day, last 7 days' })).toBeTruthy()
  })

  it('shows the not-connected state on the Instantly tiles only', () => {
    render(<KpiTiles data={base} instantly={{ configured: false, campaigns: [] }} />)
    expect(screen.getAllByText('Instantly not connected — set INSTANTLY_API_KEY')).toHaveLength(2)
    expect(values()).toEqual(['—', '7', '2', '—'])
  })

  it('shows "unreachable" when Instantly errored', () => {
    render(
      <KpiTiles
        data={{ ...base, pending_gates: 0 }}
        instantly={{ configured: true, error: 'instantly_unreachable', campaign_source: 'instantly_list', campaigns: [] }}
      />
    )
    expect(screen.getAllByText(/Instantly unreachable/)).toHaveLength(2)
    expect(screen.getByText('All clear')).toBeTruthy()
  })

  it('shimmers the Instantly tiles while that half loads', () => {
    const { container } = render(<KpiTiles data={base} instantly={undefined} />)
    expect(container.querySelectorAll('.anim-shimmer').length).toBe(2)
    expect(screen.queryByText(/not connected|unreachable/)).toBeNull()
  })
})
