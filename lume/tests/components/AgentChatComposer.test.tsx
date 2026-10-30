// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/** Composer edge cases around attached images: voice, save-skill, failed sends, per-chip errors. */

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/agent',
  useSearchParams: () => nav.params,
}))
// A stand-in mic: one click "hears" a phrase and hands it to onFinal.
vi.mock('@/components/orb/VoiceInput', () => ({
  useSpeechRecognition: () => ({ supported: true, listening: false, transcript: '', error: null, start: () => {}, stop: async () => '' }),
  VoiceInput: ({ onFinal }: { onFinal: (t: string) => void }) => (
    <button type="button" onClick={() => onFinal('spoken words')}>
      Fake mic
    </button>
  ),
}))

import { AgentChat } from '@/components/agent/AgentChat'
import { png } from '../stubs/imageHeaders'

const CONV = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const REF = { path: '0f3c2b1a-9d8e-4f7a-8b6c-000000000001.png', media_type: 'image/png' }

function sseResponse(frames: object[]) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder()
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
      c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const file = (name: string) => new File([png(10, 10)], name, { type: 'image/png' })

function setup(opts: { run?: () => Response; uploadGate?: Promise<void> } = {}) {
  const f = vi.fn(async (url: string) => {
    if (url === '/api/agent/conversations') return Response.json({ conversations: [] })
    if (url === '/api/agent/run') return opts.run?.() ?? sseResponse([{ type: 'run', id: 'r1', conversation_id: CONV }, { type: 'text', delta: 'Okay.' }, { type: 'done' }])
    if (url.startsWith('/api/agent/images?')) {
      if (opts.uploadGate) await opts.uploadGate
      return Response.json({ ...REF, name: new URL(url, 'https://lume.test').searchParams.get('name') })
    }
    if (url.startsWith('/api/agent/conversations/')) return Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json({ ok: true, items: [], skills: [] })
  })
  vi.stubGlobal('fetch', f)
  render(<AgentChat />)
  const box = screen.getByLabelText('Message Lume') as HTMLTextAreaElement
  const runBodies = () => f.mock.calls.filter((c) => c[0] === '/api/agent/run').map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string))
  return { f, box, runBodies }
}

const paste = (box: HTMLElement, files: File[]) => fireEvent.paste(box, { clipboardData: { files, types: ['Files'] } })
const uploaded = () => waitFor(() => expect(screen.queryByRole('status', { name: /Uploading/ })).toBeNull())

beforeEach(() => {
  nav.params = new URLSearchParams()
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('createImageBitmap', async () => ({ width: 10, height: 10, close() {} }))
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('composer with images', () => {
  it('a voice transcript that arrives while an image is uploading goes into the draft, not the bin', async () => {
    let release!: () => void
    const { box, runBodies } = setup({ uploadGate: new Promise<void>((r) => (release = r)) })
    paste(box, [file('a.png')])
    await screen.findByRole('status', { name: /Uploading a\.png/ })
    fireEvent.click(screen.getByRole('button', { name: 'Fake mic' }))
    expect(box.value).toBe('spoken words')
    expect(runBodies()).toEqual([])
    release()
    await uploaded()
  })

  it('a voice transcript is sent at once when nothing is pending', async () => {
    const { runBodies } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Fake mic' }))
    await screen.findByText('Okay.')
    expect(runBodies()[0]).toEqual({ prompt: 'spoken words' })
  })

  it('"Save this chat as a skill" neither sends nor clears the attached images', async () => {
    const { box, runBodies } = setup()
    fireEvent.change(box, { target: { value: 'hi' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await screen.findByText('Okay.')
    paste(box, [file('keep.png')])
    await uploaded()
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Save this chat as a skill/ }))
    await waitFor(() => expect(runBodies()).toHaveLength(2))
    expect(runBodies()[1].images).toBeUndefined()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove keep.png' })).toBeTruthy())
  })

  it('a send that fails puts the chips back; a send that succeeds clears them', async () => {
    let fail = true
    const { box, runBodies } = setup({
      run: () => (fail ? Response.json({ error: 'internal' }, { status: 500 }) : sseResponse([{ type: 'run', id: 'r1', conversation_id: CONV }, { type: 'done' }])),
    })
    paste(box, [file('retry.png')])
    await uploaded()
    fireEvent.keyDown(box, { key: 'Enter' })
    await screen.findByText(/Request failed \(500/)
    await screen.findByRole('button', { name: 'Remove retry.png' })
    fail = false
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(runBodies()).toHaveLength(2))
    expect(runBodies()[1].images).toEqual([{ path: REF.path, name: 'retry.png' }])
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove retry.png' })).toBeNull())
  })

  it('removing a chip leaves the errors about other files in place', async () => {
    const { box } = setup()
    paste(box, [new File(['%PDF-1.7'], 'notes.pdf', { type: 'application/pdf' }), file('ok.png')])
    expect((await screen.findByRole('alert')).textContent).toMatch(/notes\.pdf/)
    await uploaded()
    fireEvent.click(screen.getByRole('button', { name: 'Remove ok.png' }))
    expect(screen.getByRole('alert').textContent).toMatch(/notes\.pdf/)
  })
})
