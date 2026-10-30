// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

/** Composer with spreadsheets: paperclip / drop / paste, chips with counts, limits, the run body, the stored bubble. */

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/agent',
  useSearchParams: () => nav.params,
}))
vi.mock('@/components/orb/VoiceInput', () => ({
  useSpeechRecognition: () => ({ supported: true, listening: false, transcript: '', error: null, start: () => {}, stop: async () => '' }),
  VoiceInput: () => null,
}))
const storage = vi.hoisted(() => ({ uploadToSignedUrl: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ storage: { from: () => storage } }) }))

import { AgentChat } from '@/components/agent/AgentChat'

const CONV = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const fid = (n: number) => `0f3c2b1a-9d8e-4f7a-8b6c-${String(n).padStart(12, '0')}`

function sseResponse(frames: object[]) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`))
      c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const xlsx = (name: string, size = 2048) => new File([new Uint8Array(size)], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })

function setup(opts: { finalize?: (filename: string, id: string) => Response | null; messages?: unknown[] } = {}) {
  let n = 0
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/agent/conversations') return Response.json({ conversations: [] })
    if (url === '/api/agent/run') return sseResponse([{ type: 'run', id: 'r1', conversation_id: CONV }, { type: 'text', delta: 'Okay.' }, { type: 'done' }])
    if (url === '/api/agent/files/sign') {
      const { filename } = JSON.parse(init!.body as string)
      if (/\.xls$/i.test(filename)) return Response.json({ error: 'xls' }, { status: 415 })
      return Response.json({ path: `${fid(++n)}.xlsx`, token: 't', upload_ticket: 'k' })
    }
    if (url === '/api/agent/files') {
      const { filename, storage_path } = JSON.parse(init!.body as string)
      const id = String(storage_path).replace('.xlsx', '')
      return opts.finalize?.(filename, id) ?? Response.json({ file: { kind: 'file', id, name: filename, file_kind: 'xlsx', size_bytes: 2048, sheets: [{ name: 'Leads', rows: 1204, cols: 8 }] } }, { status: 201 })
    }
    if (url.startsWith('/api/agent/conversations/')) return opts.messages ? Response.json({ conversation: { id: CONV, title: 't' }, messages: opts.messages }) : Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json({ ok: true, items: [], skills: [], sets: [] })
  })
  vi.stubGlobal('fetch', f)
  render(<AgentChat />)
  const box = screen.getByLabelText('Message Lume') as HTMLTextAreaElement
  const runBodies = () => f.mock.calls.filter((c) => c[0] === '/api/agent/run').map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string))
  return { f, box, runBodies }
}

const pick = (files: File[]) => fireEvent.change(screen.getByTestId('agent-attach-input'), { target: { files } })
const chips = () => screen.queryByRole('list', { name: 'Attached spreadsheets' })
const ready = () => waitFor(() => expect(screen.queryByRole('status', { name: /Uploading/ })).toBeNull())

beforeEach(() => {
  nav.params = new URLSearchParams()
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView = () => {}
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
  storage.uploadToSignedUrl.mockReset().mockResolvedValue({ error: null })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('composer with spreadsheets', () => {
  it('the paperclip accepts .xlsx and .csv; a chip shows name, size and rows once parsed; Send carries only the file ids', async () => {
    const { box, runBodies } = setup()
    expect((screen.getByTestId('agent-attach-input') as HTMLInputElement).accept).toMatch(/\.xlsx.*\.csv/)
    pick([xlsx('Leads Q3.xlsx')])
    await ready()
    const list = chips()!
    expect(within(list).getByText('Leads Q3.xlsx')).toBeTruthy()
    expect(within(list).getByText('2.0 KB · 1,204 rows × 8 cols')).toBeTruthy()
    // Uploaded straight to Storage as a raw body with the xlsx type.
    expect(storage.uploadToSignedUrl).toHaveBeenCalledWith(`${fid(1)}.xlsx`, 't', expect.any(ArrayBuffer), { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    fireEvent.change(box, { target: { value: 'dedupe this' } })
    fireEvent.submit(box.closest('form')!)
    await waitFor(() => expect(runBodies()).toHaveLength(1))
    expect(runBodies()[0]).toMatchObject({ prompt: 'dedupe this', files: [{ id: fid(1) }] })
    expect(runBodies()[0].images).toBeUndefined()
    expect(chips()).toBeNull()
    // The sent bubble keeps the chip.
    await waitFor(() => expect(screen.getAllByText('Leads Q3.xlsx').length).toBeGreaterThan(0))
  })

  it('a dropped spreadsheet attaches; a file-only message can be sent', async () => {
    const { box, runBodies } = setup()
    fireEvent.drop(box.closest('form')!, { dataTransfer: { files: [xlsx('a.xlsx')], types: ['Files'] } })
    await ready()
    fireEvent.submit(box.closest('form')!)
    await waitFor(() => expect(runBodies()).toHaveLength(1))
    expect(runBodies()[0]).toMatchObject({ prompt: '', files: [{ id: fid(1) }] })
  })

  it('a pasted .csv attaches even when the paste also carries its name as text', async () => {
    const { box } = setup()
    const csv = new File(['a,b\n1,2\n'], 'list.csv', { type: 'text/csv' })
    fireEvent.paste(box, { clipboardData: { files: [csv], types: ['Files', 'text/plain'] } })
    await ready()
    expect(within(chips()!).getByText('list.csv')).toBeTruthy()
  })

  it('up to 3 per message; .xls asks for .xlsx; a server refusal leaves no chip, only the error', async () => {
    setup({ finalize: (name) => (name === 'big.xlsx' ? Response.json({ error: 'too_many_cells' }, { status: 422 }) : null) })
    pick([xlsx('big.xlsx'), xlsx('b.xlsx'), xlsx('c.xlsx'), xlsx('d.xlsx')])
    await ready()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Up to 3 spreadsheets per message/)
    expect(alert.textContent).toMatch(/big\.xlsx has more than 500,000 cells/)
    expect(within(chips()!).getAllByRole('listitem')).toHaveLength(2)
    pick([new File(['x'], 'old.xls')])
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/old\.xls is an old \.xls workbook — open it in Excel or Numbers and save as \.xlsx/))
  })

  it('images keep their own limit beside spreadsheets', async () => {
    setup()
    pick([xlsx('a.xlsx'), new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' })])
    await ready()
    expect(within(chips()!).getByText('a.xlsx')).toBeTruthy()
    // The PDF went down the image path and was refused there.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/doc\.pdf/))
  })

  it('a stored message shows its spreadsheet chips after reload', async () => {
    nav.params = new URLSearchParams(`c=${CONV}`)
    setup({
      messages: [
        {
          id: 'm1', conversation_id: CONV, role: 'user', text: 'here', tools: [], approvals: [], error: null, run_id: null, auto: false, created_at: '2026-10-30T00:00:00Z',
          attachments: [{ kind: 'file', id: fid(7), name: 'stored.xlsx', file_kind: 'xlsx', size_bytes: 4096, sheets: [{ name: 'A', rows: 10, cols: 2 }, { name: 'B', rows: 5, cols: 1 }] }],
        },
      ],
    })
    expect(await screen.findByText('stored.xlsx')).toBeTruthy()
    expect(screen.getByText('4.0 KB · 2 sheets · 15 rows')).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Spreadsheets on this message' })).toBeTruthy()
  })
})
