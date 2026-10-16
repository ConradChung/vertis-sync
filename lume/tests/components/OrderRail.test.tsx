// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { OrderRailView } from '@/components/import/OrderRail'
import type { OrderDetail } from '@/lib/import/orderDetail'

const ID = '7db3d841-252c-4572-95ec-bc110727df8d'
const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, claimed: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const ingest: OrderDetail = {
  kind: 'ingest',
  id: ID,
  status: 'awaiting_approval',
  filename: 'apify-x.csv',
  source: 'lume',
  row_count: 1234,
  email_column: 'email',
  validation_job_id: null,
  sample: { headers: ['name', 'email'], rows: [['Ann', 'ann@x.com']] },
  sample_from: 'file',
  enrichment: null,
  gate: { kind: 'ingest_approval', target_id: ID, param: `ingest_approval:${ID}` },
}

const apollo = (awaiting: boolean): OrderDetail => ({
  kind: 'apollo_order',
  id: ID,
  status: awaiting ? 'awaiting_count' : 'delivered',
  apollo_url: 'https://app.apollo.io/#/people?x=1',
  contact_count: awaiting ? null : 1000,
  credits_deducted: awaiting ? null : 1000,
  new_balance: awaiting ? null : 8000,
  leadsfriday_order_id: awaiting ? null : 4242,
  leadsfriday_status: awaiting ? null : 'delivered',
  ingest_id: null,
  error: null,
  awaiting_count: awaiting,
  gate: awaiting ? { kind: 'lfo_count', target_id: ID, param: `lfo_count:${ID}` } : null,
})

describe('OrderRailView', () => {
  it('loading and error states', () => {
    const { rerender } = render(<OrderRailView kind="ingest" detail={undefined} />)
    expect(screen.getByLabelText('Loading order')).toBeTruthy()
    const onRetry = vi.fn()
    rerender(<OrderRailView kind="ingest" detail={undefined} error={new Error('x')} onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('ingest: facts, sample table, Validate link, enrichment chosen at approval', () => {
    render(<OrderRailView kind="ingest" detail={ingest} />)
    expect(screen.getByText('apify-x.csv')).toBeTruthy()
    expect(screen.getByText('1,234')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'email' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'ann@x.com' })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open in Validate/ }).getAttribute('href')).toBe(`/validate?gate=${encodeURIComponent(`ingest_approval:${ID}`)}`)
    expect(screen.getByText(/Enrichment is chosen at approval/)).toBeTruthy()
  })

  it('dashboard_job: read-only enrichment config', () => {
    render(
      <OrderRailView
        kind="dashboard_job"
        detail={{
          kind: 'dashboard_job',
          id: ID,
          status: 'processing',
          filename: 'f.csv',
          row_count: 10,
          sample: null,
          enrichment: { enrich: true, icp_filter: false, icp_description: 'Founders of B2B SaaS' },
          gate: null,
        }}
      />
    )
    const cfg = within(screen.getByRole('region', { name: 'Enrichment config' }))
    expect(cfg.getByText('On')).toBeTruthy()
    expect(cfg.getByText('Off')).toBeTruthy()
    expect(cfg.getByText('Founders of B2B SaaS')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('link', { name: /Open in Validate/ })).toBeNull()
  })

  it('apollo_order awaiting a count: choose, then click Order → lfo_count:<id>:<n>', async () => {
    const onDecided = vi.fn()
    render(<OrderRailView kind="apollo_order" detail={apollo(true)} onDecided={onDecided} />)
    const order = screen.getByRole('button', { name: 'Order' })
    expect((order as HTMLButtonElement).disabled).toBe(true)

    // A key press never orders.
    fireEvent.keyDown(document.body, { key: 'a' })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('radio', { name: '2,000' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Order 2,000' }))
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/gates/decide')
    expect(JSON.parse(String(init.body))).toEqual({ callback_data: `lfo_count:${ID}:2000` })
    expect(onDecided).toHaveBeenCalled()
  })

  it('custom count must be 500–50 000', async () => {
    render(<OrderRailView kind="apollo_order" detail={apollo(true)} />)
    const input = screen.getByLabelText('Custom count')
    fireEvent.change(input, { target: { value: '499' } })
    expect((screen.getByRole('button', { name: 'Order' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '50001' } })
    expect((screen.getByRole('button', { name: 'Order' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '750' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Order 750' }))
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ callback_data: `lfo_count:${ID}:750` })
  })

  it('a 409 says it was already handled', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'already_handled' }), { status: 409 }))
    render(<OrderRailView kind="apollo_order" detail={apollo(true)} />)
    fireEvent.click(screen.getByRole('radio', { name: '500' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Order 500' }))
    })
    expect(screen.getByText(/Already handled/)).toBeTruthy()
  })

  it('apollo_order after ordering: credits and Leadsfriday id, no picker', () => {
    render(<OrderRailView kind="apollo_order" detail={apollo(false)} />)
    expect(screen.getByText('#4242')).toBeTruthy()
    expect(screen.getByText('8,000')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Leadsfriday count' })).toBeNull()
  })

  it('job_batch: counts and its gate', () => {
    render(
      <OrderRailView
        kind="job_batch"
        detail={{
          kind: 'job_batch',
          id: ID,
          status: 'awaiting_review',
          batch_date: '2026-10-12',
          counts: { companies_added: 40, companies_pulled: 31, companies_unresolved: 2, contacts_total: 0, contacts_kept: 0 },
          leadsfriday_order_id: null,
          leadsfriday_status: null,
          error: null,
          gate: { kind: 'jobs_review', target_id: ID, param: `jobs_review:${ID}` },
        }}
      />
    )
    expect(screen.getByText('2026-10-12')).toBeTruthy()
    expect(screen.getByText('31')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open in Validate/ }).getAttribute('href')).toBe(`/validate?gate=${encodeURIComponent(`jobs_review:${ID}`)}`)
  })
})
