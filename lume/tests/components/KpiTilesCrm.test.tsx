// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('@/components/ui/number-ticker', () => ({
  NumberTicker: ({ value }: { value: number }) => <span>{value}</span>,
}))

import { KpiTiles } from '@/components/overview/KpiTiles'

afterEach(cleanup)

describe('Pending approvals counts CRM follow-ups due', () => {
  it('adds crm_followups_due to the gate count and says so', () => {
    render(
      <KpiTiles
        data={{ replies_today: 0, replies_7d: [0, 0], pending_gates: 2, gates_opened_7d: [0, 0], crm_followups_due: 3 }}
        instantly={{ configured: false, campaigns: [] }}
      />
    )
    expect(screen.getByRole('link', { name: 'Pending approvals: 5, including 3 CRM follow-ups due. Open Validate' })).toBeTruthy()
    expect(screen.getByText('3 CRM follow-ups due')).toBeTruthy()
  })
})
