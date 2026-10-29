// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const storage = vi.hoisted(() => ({ uploadToSignedUrl: vi.fn() }))
const nav = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ storage: { from: () => ({ uploadToSignedUrl: storage.uploadToSignedUrl }) } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }) }))

import { AUTOSAVE_MS, ProjectView } from '@/components/agent/ProjectView'

const PID = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b01'
const now = new Date().toISOString()
const project = { id: PID, name: 'Roofers', instructions: 'Tone: casual.', vertical_id: null, position: 0, created_at: now, updated_at: now }
const items = [
  { id: 'n1', kind: 'note', name: 'Pricing', mime: 'text/plain', size_bytes: 20, readable: true, truncated: false, created_at: now },
  { id: 'f1', kind: 'file', name: 'scan.pdf', mime: 'application/pdf', size_bytes: 2048, readable: false, truncated: false, created_at: now },
]

const fetchMock = vi.fn()
const calls = (method: string, url: string) =>
  fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? 'GET') === method).map(([, init]) => JSON.parse(String(init?.body ?? 'null')))

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === `/api/agent/projects/${PID}` && method === 'GET') return Response.json({ project, items, conversations: [{ id: 'c1', title: 'Austin plan', created_at: now, updated_at: now }] })
    if (url === `/api/agent/projects/${PID}` && method === 'PATCH') return Response.json({ project: { ...project, ...JSON.parse(String(init?.body)) } })
    if (url === '/api/verticals') return Response.json({ verticals: [{ id: 'v1', name: 'Roofing' }] })
    if (url.endsWith('/notes')) return Response.json({ item: { id: 'n9', kind: 'note', name: 'Avoid franchises', mime: 'text/plain', size_bytes: 16, readable: true, truncated: false, created_at: now } }, { status: 201 })
    if (url.endsWith('/files/sign')) return Response.json({ path: `${PID}/x.csv`, token: 'tok', upload_ticket: 't' })
    if (url === `/api/agent/projects/${PID}/files`) return Response.json({ item: { id: 'f9', kind: 'file', name: 'leads.csv', mime: 'text/csv', size_bytes: 12, readable: true, truncated: false, created_at: now } }, { status: 201 })
    return Response.json({ ok: true })
  })
  vi.stubGlobal('fetch', fetchMock)
  storage.uploadToSignedUrl.mockReset()
  storage.uploadToSignedUrl.mockResolvedValue({ error: null })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ProjectView', () => {
  it('shows instructions, items (unreadable marked), chats and New chat in project', async () => {
    render(<ProjectView id={PID} />)
    expect(((await screen.findByLabelText('Project instructions')) as HTMLTextAreaElement).value).toBe('Tone: casual.')
    expect(screen.getByText('Pricing')).toBeTruthy()
    expect(screen.getByText(/not readable/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Austin plan' }).getAttribute('href')).toBe('/agent?c=c1')
    expect(screen.getByRole('link', { name: /New chat in project/ }).getAttribute('href')).toBe(`/agent?project=${PID}`)
  })

  it('autosaves instructions after a pause in typing', async () => {
    render(<ProjectView id={PID} />)
    const box = await screen.findByLabelText('Project instructions')
    vi.useFakeTimers()
    fireEvent.change(box, { target: { value: 'Never order more than 2k.' } })
    expect(calls('PATCH', `/api/agent/projects/${PID}`)).toHaveLength(0)
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_MS + 10)
    })
    vi.useRealTimers()
    await waitFor(() => expect(calls('PATCH', `/api/agent/projects/${PID}`)).toEqual([{ instructions: 'Never order more than 2k.' }]))
    expect(await screen.findByText('Saved')).toBeTruthy()
  })

  it('dropping files on the drop zone uploads them and lists them', async () => {
    render(<ProjectView id={PID} />)
    const zone = await screen.findByTestId('project-drop-zone')
    const file = new File(['email\na@b.co'], 'leads.csv', { type: 'text/csv' })
    const data = { types: ['Files'], files: [file], getData: () => '', dropEffect: 'none' }
    fireEvent.dragOver(zone, { dataTransfer: data })
    expect(zone.className).toContain('border-primary')
    fireEvent.drop(zone, { dataTransfer: data })
    expect(await screen.findByText('leads.csv')).toBeTruthy()
    expect(storage.uploadToSignedUrl).toHaveBeenCalledTimes(1)
  })

  it('deletes an item', async () => {
    render(<ProjectView id={PID} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Pricing' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === `/api/agent/projects/${PID}/files/n1` && i?.method === 'DELETE')).toBe(true))
    expect(screen.queryByText('Pricing')).toBeNull()
  })

  it('adds a note', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ project, items: [], conversations: [] }))
    render(<ProjectView id={PID} />)
    fireEvent.change(await screen.findByLabelText('New note'), { target: { value: 'Avoid franchises' } })
    fireEvent.click(screen.getByRole('button', { name: /Add note/ }))
    await waitFor(() => expect(calls('POST', `/api/agent/projects/${PID}/notes`)).toEqual([{ content: 'Avoid franchises' }]))
  })

  it('a missing project says so', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ error: 'not_found' }, { status: 404 }))
    render(<ProjectView id={PID} />)
    expect(await screen.findByText(/This project isn.t here/)).toBeTruthy()
  })
})
