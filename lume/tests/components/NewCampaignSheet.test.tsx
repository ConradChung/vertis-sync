// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'

const JOB = '16f26ffc-f8e5-47a5-9e1b-7532f61dad75'
const KASPEN = '466d9a53-6450-49df-a063-8e66437efa8b'
const TID = '23450833-3650-439f-86b4-2521f4141a2d'
const SCHED = { schedules: [{ name: 'Weekdays', timing: { from: '08:00', to: '16:00' }, days: { '1': true, '2': true, '3': true, '4': true, '5': true }, timezone: 'America/New_York' }] }

const suggestion = {
  source: { kind: 'job', id: JOB, label: 'leadsfriday-4445.csv', vertical_id: KASPEN, rows: 5255, awaiting_campaign: true },
  profile: { rows: 500, industries: [{ value: 'real estate', n: 400, share: 0.8 }], titles: [], keywords: [], locations: [], roles: [{ value: 'owner', n: 300, share: 0.6 }], without_city: 200, columns: {} },
  verticals: [{ id: KASPEN, name: 'Kaspen / Zenport', score: 2, coverage: 0.9, history: 0, source: 'tagged', why: 'Already tagged Kaspen / Zenport (88% of industries mention real estate)' }],
  suggestion: {
    vertical_id: KASPEN,
    vertical_name: 'Kaspen / Zenport',
    vertical_why: 'Already tagged Kaspen / Zenport (88% of industries mention real estate)',
    template_id: TID,
    template_name: 'Zenport Campaign',
    template_why: 'Tagged Kaspen / Zenport',
    name: 'Kaspen — Real estate owners — Nov 2026',
    segment: 'Real estate owners',
    settings: { source_campaign_id: 'c1', source_campaign_name: 'Kaspen', email_list: ['a@send.com'], campaign_schedule: SCHED, daily_limit: 30, stop_on_reply: true, why: 'Copied from Kaspen, the latest Kaspen / Zenport campaign' },
    no_location: { advisable: true, rows_without_city: 200, share: 0.4, why: '40% of rows have no city — a sibling without {{location}} keeps them sendable' },
    no_location_template_id: null,
  },
  options: {
    verticals: [{ id: KASPEN, name: 'Kaspen / Zenport' }],
    templates: [{ id: TID, name: 'Zenport Campaign', vertical_id: KASPEN, no_location: false, uses_location: true, why: 'Tagged Kaspen / Zenport', description: null, preview: { steps: 3, variants: 3, subject: 'owners in {{location}}', body: 'Hey {{firstName}}' } }],
    accounts: [{ email: 'a@send.com', status: 'active', warmup_score: 100 }, { email: 'b@send.com', status: 'active', warmup_score: 98 }],
    sources: { jobs: [{ id: JOB, label: 'leadsfriday-4445.csv', rows: 5255, created_at: '', vertical_id: KASPEN }], lists: [] },
  },
  instantly: { configured: true },
}

const fetched: string[] = []
const sendJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/validate/client', () => ({ sendJson }))
vi.mock('@/hooks/fetcher', () => ({
  fetchJson: async (k: string) => {
    fetched.push(k)
    return suggestion
  },
}))

import { NewCampaignSheet } from '@/components/campaigns/NewCampaignSheet'

const ui = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <NewCampaignSheet open onOpenChange={() => {}} jobId={JOB} />
    </SWRConfig>
  )

beforeEach(() => {
  sendJson.mockReset()
  fetched.length = 0
})
afterEach(cleanup)

describe('New campaign sheet', () => {
  it('pre-fills from the job: name, why, template preview, inboxes, schedule, limit, No-Location toggle', async () => {
    ui()
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement
    expect(fetched[0]).toBe(`/api/campaigns/suggest?job_id=${JOB}`)
    expect(name.value).toBe('Kaspen — Real estate owners — Nov 2026')
    expect(screen.getByText(/Already tagged Kaspen \/ Zenport/)).toBeTruthy()
    expect(screen.getByLabelText('Sequence preview').textContent).toContain('3 steps')
    expect((screen.getByRole('checkbox', { name: /a@send\.com/ }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: /b@send\.com/ }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText('Mon–Fri 08:00–16:00 America/New_York')).toBeTruthy()
    expect((screen.getByLabelText('Daily limit') as HTMLInputElement).value).toBe('30')
    expect(screen.getByRole('switch', { name: /No-Location sibling/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/Copied from Kaspen/)).toBeTruthy()
  })

  it('submits the edited form as a pending action and links to it', async () => {
    sendJson.mockResolvedValue({ status: 201, body: { ok: true, action: { id: 'act-9', summary: 'New campaign “Mine” …' } } })
    ui()
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Mine' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /b@send\.com/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Send for confirmation' }))
    await waitFor(() => expect(screen.getByText('Sent for your confirmation')).toBeTruthy())
    expect(sendJson).toHaveBeenCalledWith('/api/campaigns/new', {
      name: 'Mine',
      vertical_id: KASPEN,
      template_id: TID,
      email_list: ['a@send.com', 'b@send.com'],
      campaign_schedule: SCHED,
      daily_limit: 30,
      stop_on_reply: true,
      job_id: JOB,
      no_location_sibling: true,
    })
    expect(screen.getByRole('link', { name: /Review and confirm/ }).getAttribute('href')).toBe('/actions/act-9')
  })

  it('a refusal shows a readable error and files nothing else', async () => {
    sendJson.mockResolvedValue({ status: 409, body: { error: 'name_taken' } })
    ui()
    await screen.findByLabelText('Name')
    fireEvent.click(screen.getByRole('button', { name: 'Send for confirmation' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already exists in Instantly/))
  })
})
