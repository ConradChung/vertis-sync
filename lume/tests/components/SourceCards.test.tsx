// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
const uploadToSignedUrl = vi.hoisted(() => vi.fn())
const from = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ storage: { from: (b: string) => (from(b), { uploadToSignedUrl }) } }),
}))

import { SourceCards } from '@/components/import/SourceCards'

const ID = '7db3d841-252c-4572-95ec-bc110727df8d'
const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  uploadToSignedUrl.mockReset()
  uploadToSignedUrl.mockResolvedValue({ data: { path: 'p' }, error: null })
  from.mockReset()
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

const SIGNED = { path: 'lume/0b6f6c1e-8a51-4c43-9d0e-6e7a1f3b2c4d.csv', token: 'tok', signedUrl: 'https://s', upload_ticket: 'f'.repeat(64) }
const fileInput = () => document.querySelector('[data-testid="csv-input"]') as HTMLInputElement

describe('SourceCards — CSV', () => {
  it('refuses files that are not .csv / .xlsx, and asks for .xlsx instead of .xls, without uploading', async () => {
    render(<SourceCards />)
    const card = within(region(/CSV intake/))
    await act(async () => {
      fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'a.pdf')] } })
    })
    expect(card.getByRole('status').textContent).toBe('Only .csv or .xlsx files.')
    await act(async () => {
      fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'old.xls')] } })
    })
    expect(card.getByRole('status').textContent).toBe('Old .xls workbook — open it in Excel or Numbers and save as .xlsx.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the browse control is named for screen readers', () => {
    render(<SourceCards />)
    expect(within(region(/CSV intake/)).getByRole('button', { name: 'Browse for a CSV or Excel file' })).toBeTruthy()
  })

  it('a dropped .csv: sign → upload straight to Storage → ingest the stored object', async () => {
    const onCreated = vi.fn()
    render(<SourceCards onCreated={onCreated} />)
    const card = within(region(/CSV intake/))
    fetchMock
      .mockResolvedValueOnce(ok(SIGNED))
      .mockResolvedValueOnce(ok({ ok: true, ingest_id: ID, row_count: 2, email_column: null, telegram: 'skipped', gate: `ingest_approval:${ID}` }))
    const file = new File(['email\na\nb\n'], 'leads.csv', { type: 'text/csv' })
    const zone = card.getByText('Drop a .csv or .xlsx here').parentElement!
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    })
    const [signUrl, signInit] = fetchMock.mock.calls[0]
    expect(signUrl).toBe('/api/import/csv/sign')
    expect(JSON.parse(String(signInit.body))).toEqual({ filename: 'leads.csv', size: file.size })
    expect(from).toHaveBeenCalledWith('raw-uploads')
    expect(uploadToSignedUrl).toHaveBeenCalledWith(SIGNED.path, 'tok', file, { contentType: 'text/csv' })
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/import/csv')
    expect(JSON.parse(String(init.body))).toEqual({ storage_path: SIGNED.path, filename: 'leads.csv', upload_ticket: SIGNED.upload_ticket })
    expect(card.getByRole('status').textContent).toMatch(/2 rows\. Telegram not configured — decide it in Validate/)
    expect(onCreated).toHaveBeenCalledWith({ kind: 'ingest', id: ID })
  })

  it('a failed sign stops before uploading; a failed upload never submits', async () => {
    render(<SourceCards />)
    const card = within(region(/CSV intake/))
    fetchMock.mockResolvedValueOnce(ok({ error: 'too_large' }, 413))
    await act(async () => {
      fireEvent.change(fileInput(), { target: { files: [new File(['email\na\n'], 'a.csv')] } })
    })
    expect(uploadToSignedUrl).not.toHaveBeenCalled()
    expect(card.getByRole('status').textContent).toBe('Over the 20 MB limit.')

    fetchMock.mockResolvedValueOnce(ok(SIGNED))
    uploadToSignedUrl.mockResolvedValueOnce({ data: null, error: new Error('nope') })
    await act(async () => {
      fireEvent.change(fileInput(), { target: { files: [new File(['email\na\n'], 'b.csv')] } })
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(card.getByRole('status').textContent).toBe('Could not save the file — try again.')
  })

  it('files over 20 MB are refused before signing', async () => {
    render(<SourceCards />)
    const big = new File(['x'], 'big.csv')
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 })
    await act(async () => {
      fireEvent.change(fileInput(), { target: { files: [big] } })
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('SourceCards — Excel', () => {
  const FILE = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
  const XSIGN = { path: `${FILE}.xlsx`, token: 'xt', signedUrl: 'https://s', upload_ticket: 'k' }
  const xfile = () => new File([new Uint8Array(100)], 'book.xlsx')
  const ref = (sheets: { name: string; rows: number; cols: number; hidden?: boolean }[]) => ({ file: { kind: 'file', id: FILE, name: 'book.xlsx', file_kind: 'xlsx', size_bytes: 100, sheets } })
  const INGEST = { ok: true, ingest_id: ID, row_count: 3, email_column: 'Email', telegram: 'sent', gate: `ingest_approval:${ID}` }

  it('a one-sheet workbook: upload + parse through the chat file routes, then that sheet goes to the CSV intake', async () => {
    const onCreated = vi.fn()
    render(<SourceCards onCreated={onCreated} />)
    const card = within(region(/CSV intake/))
    fetchMock.mockResolvedValueOnce(ok(XSIGN)).mockResolvedValueOnce(ok(ref([{ name: 'Leads', rows: 3, cols: 2 }, { name: 'Empty', rows: 0, cols: 0 }]), 201)).mockResolvedValueOnce(ok(INGEST))
    await act(async () => {
      fireEvent.change(fileInput(), { target: { files: [xfile()] } })
    })
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/agent/files/sign', '/api/agent/files', '/api/import/xlsx'])
    expect(from).toHaveBeenCalledWith('agent-chat-files')
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body))).toEqual({ file_id: FILE, sheet: 'Leads' })
    expect(card.getByRole('status').textContent).toMatch(/3 rows\. Prompt sent to Telegram/)
    expect(onCreated).toHaveBeenCalledWith({ kind: 'ingest', id: ID })
  })

  it('several sheets with rows: asks which one, then imports the pick', async () => {
    render(<SourceCards />)
    const card = within(region(/CSV intake/))
    fetchMock.mockResolvedValueOnce(ok(XSIGN)).mockResolvedValueOnce(ok(ref([{ name: 'Old', rows: 9, cols: 2, hidden: true }, { name: 'Q3', rows: 1204, cols: 8 }, { name: 'Q4', rows: 2, cols: 8 }]), 201))
    await act(async () => {
      fireEvent.change(fileInput(), { target: { files: [xfile()] } })
    })
    const select = card.getByLabelText(/book\.xlsx has 3 sheets with rows/) as HTMLSelectElement
    expect(select.value).toBe('Q3')
    expect([...select.options].map((o) => o.textContent)).toEqual(['Old · 9 rows (hidden)', 'Q3 · 1,204 rows', 'Q4 · 2 rows'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fireEvent.change(select, { target: { value: 'Q4' } })
    fetchMock.mockResolvedValueOnce(ok(INGEST))
    await act(async () => {
      fireEvent.click(card.getByRole('button', { name: 'Import sheet' }))
    })
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body))).toEqual({ file_id: FILE, sheet: 'Q4' })
  })

  it('a parse refusal names the file and the reason; nothing is ingested', async () => {
    render(<SourceCards />)
    const card = within(region(/CSV intake/))
    fetchMock.mockResolvedValueOnce(ok(XSIGN)).mockResolvedValueOnce(ok({ error: 'legacy_or_encrypted' }, 415))
    await act(async () => {
      fireEvent.change(fileInput(), { target: { files: [xfile()] } })
    })
    expect(card.getByRole('status').textContent).toBe('book.xlsx is an old .xls or a password-protected workbook — save it as .xlsx without a password.')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
