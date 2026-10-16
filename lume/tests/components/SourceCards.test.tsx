// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { SourceCards } from '@/components/import/SourceCards'

const ID = '7db3d841-252c-4572-95ec-bc110727df8d'
const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const region = (name: RegExp) => screen.getByRole('region', { name })
const deferred = () => {
  let resolve!: (r: Response) => void
  const p = new Promise<Response>((r) => (resolve = r))
  return { p, resolve }
}

describe('SourceCards — Apify', () => {
  it('Pull is disabled until an id is typed; busy while pulling; success links the gate and reports the new ingest', async () => {
    const onCreated = vi.fn()
    render(<SourceCards onCreated={onCreated} />)
    const card = within(region(/Apify intake/))
    const pull = card.getByRole('button', { name: /Pull/ })
    expect((pull as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(card.getByLabelText('Apify dataset ID'), { target: { value: 'hLx2Q8k1sTn5vCzE3' } })
    expect((pull as HTMLButtonElement).disabled).toBe(false)

    const d = deferred()
    fetchMock.mockReturnValueOnce(d.p)
    await act(async () => {
      fireEvent.click(pull)
    })
    expect((pull as HTMLButtonElement).disabled).toBe(true)
    expect(pull.getAttribute('aria-busy')).toBe('true')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/import/apify')
    expect(JSON.parse(String(init.body))).toEqual({ dataset_id: 'hLx2Q8k1sTn5vCzE3' })

    await act(async () => {
      d.resolve(ok({ ok: true, ingest_id: ID, row_count: 1234, email_column: 'email', telegram: 'sent', gate: `ingest_approval:${ID}`, truncated: false }))
    })
    expect(card.getByRole('status').textContent).toMatch(/1,234 rows\. Prompt sent to Telegram/)
    expect(card.getByRole('link', { name: /Open in Validate/ }).getAttribute('href')).toBe(`/validate?gate=${encodeURIComponent(`ingest_approval:${ID}`)}`)
    expect(onCreated).toHaveBeenCalledWith({ kind: 'ingest', id: ID })
  })

  it('actor mode sends actor_id; an error answer shows its message', async () => {
    render(<SourceCards />)
    const card = within(region(/Apify intake/))
    fireEvent.click(card.getByRole('radio', { name: 'Actor ID' }))
    fireEvent.change(card.getByLabelText('Apify actor ID'), { target: { value: 'me~scraper' } })
    fetchMock.mockResolvedValueOnce(ok({ error: 'no_succeeded_run' }, 404))
    await act(async () => {
      fireEvent.click(card.getByRole('button', { name: /Pull/ }))
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ actor_id: 'me~scraper' })
    expect(card.getByRole('status').textContent).toBe('That actor has no succeeded run.')
  })
})

describe('SourceCards — Apollo link', () => {
  it('validates the URL client-side, then shows "sent to scraper, waiting on count"', async () => {
    const onCreated = vi.fn()
    render(<SourceCards onCreated={onCreated} />)
    const card = within(region(/Apollo link intake/))
    const input = card.getByLabelText('Apollo people search URL')
    const pull = card.getByRole('button', { name: /Pull/ })

    fireEvent.change(input, { target: { value: 'https://app.apollo.io/#/companies?x=1' } })
    expect((pull as HTMLButtonElement).disabled).toBe(true)
    expect(input.getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(input, { target: { value: 'https://app.apollo.io/#/people?page=1' } })
    expect((pull as HTMLButtonElement).disabled).toBe(false)
    fetchMock.mockResolvedValueOnce(ok({ ok: true, order_id: ID, telegram: 'skipped', gate: `lfo_count:${ID}` }))
    await act(async () => {
      fireEvent.click(pull)
    })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/import/apollo-link')
    expect(card.getByRole('status').textContent).toMatch(/Sent to scraper, waiting on count/)
    expect(onCreated).toHaveBeenCalledWith({ kind: 'apollo_order', id: ID })
  })
})

describe('SourceCards — CSV', () => {
  it('refuses non-.csv files without uploading', async () => {
    render(<SourceCards />)
    const card = within(region(/CSV intake/))
    await act(async () => {
      fireEvent.change(card.getByLabelText('Choose a CSV file'), { target: { files: [new File(['x'], 'a.xlsx')] } })
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(card.getByRole('status').textContent).toBe('Only .csv files.')
  })

  it('a dropped .csv uploads as multipart and reports the ingest', async () => {
    const onCreated = vi.fn()
    render(<SourceCards onCreated={onCreated} />)
    const card = within(region(/CSV intake/))
    fetchMock.mockResolvedValueOnce(ok({ ok: true, ingest_id: ID, row_count: 2, email_column: null, telegram: 'skipped', gate: `ingest_approval:${ID}` }))
    const zone = card.getByText('Drop a .csv here').parentElement!
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [new File(['email\na\nb\n'], 'leads.csv', { type: 'text/csv' })] } })
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/import/csv')
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('file')).toBeInstanceOf(File)
    expect(card.getByRole('status').textContent).toMatch(/2 rows\. Telegram not configured — decide it in Validate/)
    expect(onCreated).toHaveBeenCalledWith({ kind: 'ingest', id: ID })
  })

  it('a 413 shows the size message', async () => {
    render(<SourceCards />)
    const card = within(region(/CSV intake/))
    fetchMock.mockResolvedValueOnce(ok({ error: 'too_large' }, 413))
    await act(async () => {
      fireEvent.change(card.getByLabelText('Choose a CSV file'), { target: { files: [new File(['email\na\n'], 'a.csv')] } })
    })
    expect(card.getByRole('status').textContent).toBe('Over the 20 MB limit.')
  })
})
