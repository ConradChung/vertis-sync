// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { CampaignTable } from '@/components/campaigns/CampaignTable'
import { CampaignStrip } from '@/components/overview/CampaignStrip'
import type { CampaignTableRow } from '@/lib/campaigns/types'
import type { CampaignStripItem } from '@/lib/overview/types'

afterEach(cleanup)

const row = (o: Partial<CampaignTableRow>): CampaignTableRow => ({
  key: o.name ?? 'k', instantly_id: null, lume_id: null, name: 'C', family: 'kaspen', sender_type: 'instantly', status: 'active',
  sent: 1000, replies: 10, reply_rate: 1, opportunities: 1, bounced: 15, last_activity: null, ...o,
})

describe('CampaignTable bounce rate', () => {
  it('has a Bounce rate column: bounced ÷ sent, green / amber / red, dash when nothing sent', () => {
    render(
      <CampaignTable
        rows={[row({ name: 'Low', bounced: 15 }), row({ name: 'Mid', bounced: 40 }), row({ name: 'High', bounced: 80 }), row({ name: 'None', sent: 0, bounced: 0 })]}
        instantly="ok"
        selectedKey={null}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByRole('columnheader', { name: 'Bounce rate' })).toBeTruthy()
    const cell = (name: string) => within(screen.getByText(name).closest('tr')!).getByTestId('bounce-rate')
    expect([cell('Low').textContent, cell('Mid').textContent, cell('High').textContent, cell('None').textContent]).toEqual(['1.5%', '4.0%', '8.0%', '—'])
    expect(cell('Low').className).toContain('text-green')
    expect(cell('Mid').className).toContain('text-amber')
    expect(cell('High').className).toContain('text-red')
  })
})

describe('CampaignStrip bounce rate', () => {
  it('shows each campaign\'s lifetime bounce rate in its band colour', () => {
    const item = (o: Partial<CampaignStripItem>): CampaignStripItem => ({
      id: 'x', name: 'A', sender: 'instantly', status: 'active', reply_rate: 1, sent: 500, replies: 5, series: [], bounces_24h: 0,
      bounce_rate: null, health: { level: 'green', reason: 'ok' }, ...o,
    })
    render(<CampaignStrip campaigns={[item({ id: 'a', name: 'A', bounce_rate: 6.2 }), item({ id: 'b', name: 'B', bounce_rate: null })]} />)
    const a = screen.getByText('6.2% bounced')
    expect(a.className).toContain('text-red')
    expect(screen.getAllByText(/% bounced$/)).toHaveLength(1) // B has no sends to rate
  })
})
