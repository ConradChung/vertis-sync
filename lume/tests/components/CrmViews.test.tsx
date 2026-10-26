// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { CrmBoard } from '@/components/crm/CrmBoard'
import { CrmTable } from '@/components/crm/CrmTable'
import { DEFAULT_STAGES } from '@/lib/crm/stages'
import type { CrmDealCard } from '@/lib/crm/types'

afterEach(cleanup)

const card = (i: number, stage: string, over: Partial<CrmDealCard> = {}): CrmDealCard => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  campaign_id: i % 2 ? 'camp-a' : 'camp-b',
  lead_id: i,
  email: `lead${i}@example.com`,
  name: `Lead ${i}`,
  company: `Co ${i}`,
  city: 'Austin',
  source: 'instantly',
  stage,
  owner: i === 1 ? 'me' : null,
  next_action_at: null,
  next_action: null,
  last_activity_at: new Date(Date.now() - 3_600_000).toISOString(),
  won_lost_reason: null,
  notes: null,
  followup_flagged_at: null,
  created_at: '',
  updated_at: '',
  snippet: i === 2 ? 'Happy to chat next week' : null,
  ...over,
})

const deals = [card(1, 'Contacted'), card(2, 'Replied'), card(3, 'Replied'), card(4, 'Interested'), card(5, 'Bounced')]
const names = (id: string) => (id === 'camp-a' ? 'Alpha' : 'Beta')

describe('CrmBoard', () => {
  it('renders one column per stage with counts and conversion', () => {
    render(<CrmBoard deals={deals} stages={DEFAULT_STAGES} awaiting={{}} showCampaign={false} campaignName={names} onOpen={vi.fn()} onMove={vi.fn()} />)
    const cols = screen.getAllByTestId('crm-column')
    expect(cols).toHaveLength(8)
    const replied = cols.find((c) => c.getAttribute('aria-label') === 'Replied: 2')!
    expect(within(replied).getAllByTestId('crm-card')).toHaveLength(2)
    // 5 reached Contacted, 3 reached Replied+ → 60%
    expect(within(replied).getByText('60%')).toBeTruthy()
    expect(screen.getByText('“Happy to chat next week”')).toBeTruthy()
    expect(screen.queryByText('Alpha')).toBeNull()
  })

  it('all-campaigns board badges each card with its campaign; awaiting cards say so', () => {
    render(
      <CrmBoard deals={deals} stages={DEFAULT_STAGES} awaiting={{ [deals[3].id]: 'pa-1' }} showCampaign campaignName={names} onOpen={vi.fn()} onMove={vi.fn()} />
    )
    expect(screen.getAllByText('Alpha')).toHaveLength(3)
    expect(screen.getAllByText('Beta')).toHaveLength(2)
    expect(screen.getByText('Awaiting approval')).toBeTruthy()
  })

  it('clicking a card opens it', () => {
    const onOpen = vi.fn()
    render(<CrmBoard deals={deals} stages={DEFAULT_STAGES} awaiting={{}} showCampaign={false} campaignName={names} onOpen={onOpen} onMove={vi.fn()} />)
    fireEvent.click(screen.getByText('Lead 4'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: deals[3].id }))
  })
})

describe('CrmTable', () => {
  it('lists every deal and opens a row on click', () => {
    const onOpen = vi.fn()
    render(<CrmTable deals={deals} stages={DEFAULT_STAGES} owners={['me']} showCampaign={false} campaignName={names} onOpen={onOpen} />)
    const rows = screen.getAllByTestId('crm-row')
    expect(rows).toHaveLength(5)
    expect(screen.getByText('5 of 5')).toBeTruthy()
    fireEvent.click(screen.getByText('lead5@example.com'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ email: 'lead5@example.com' }))
  })

  it('shows the campaign column on the all-campaigns view', () => {
    render(<CrmTable deals={deals} stages={DEFAULT_STAGES} owners={[]} showCampaign campaignName={names} onOpen={vi.fn()} />)
    expect(screen.getByText('Campaign')).toBeTruthy()
    expect(screen.getAllByText('Alpha')).toHaveLength(3)
  })
})
