// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'

const storage = vi.hoisted(() => ({ uploadToSignedUrl: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ storage: { from: () => ({ uploadToSignedUrl: storage.uploadToSignedUrl }) } }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { AgentHistory, type ConversationList } from '@/components/agent/AgentHistory'
import type { ProjectList } from '@/hooks/useProjectList'
import type { ConversationSummary } from '@/lib/agent/history'
import type { ProjectSummary } from '@/lib/agent/projectModel'
import { CHAT_DRAG, PROJECT_DRAG } from '@/lib/agent/projectClient'

const P1 = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b01'
const P2 = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b02'
const C1 = '1f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b01'
const C2 = '1f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b02'
const now = new Date().toISOString()
const project = (id: string, name: string, position: number): ProjectSummary => ({
  id, name, position, instructions: '', vertical_id: null, created_at: now, updated_at: now, item_count: 0, total_bytes: 0,
})
const chats: ConversationSummary[] = [
  { id: C1, title: 'Roofing plan', created_at: now, updated_at: now, project_id: null },
  { id: C2, title: 'Dentist ICP', created_at: now, updated_at: now, project_id: P1 },
]

/** A minimal DataTransfer: jsdom has none. */
function dt(data: Record<string, string> = {}, files: File[] = []) {
  const store = { ...data }
  return {
    types: [...Object.keys(store), ...(files.length ? ['Files'] : [])],
    files,
    getData: (t: string) => store[t] ?? '',
    setData: (t: string, v: string) => {
      store[t] = v
    },
    dropEffect: 'none',
    effectAllowed: 'all',
  }
}

function Harness() {
  const [items, setItems] = useState<ConversationSummary[] | null>(chats)
  const [error, setError] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[] | null>([project(P1, 'Dentists', 0), project(P2, 'Roofers', 1)])
  const list: ConversationList = { items, error, setItems, setError }
  const plist: ProjectList = { items: projects, setItems: setProjects, reload: async () => {} }
  return (
    <AgentHistory
      list={list}
      projects={plist}
      activeId={null}
      busy={false}
      onSelect={() => {}}
      onNew={() => {}}
      onNewInProject={() => {}}
      onOpenProject={() => {}}
      onDeletedActive={() => {}}
    />
  )
}

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
  storage.uploadToSignedUrl.mockReset()
  storage.uploadToSignedUrl.mockResolvedValue({ error: null })
  try {
    localStorage.removeItem("lume.agent.projects.open")
  } catch {
    // no storage in this environment
  }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const calls = (method: string, url: string) =>
  fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? 'GET') === method).map(([, init]) => JSON.parse(String(init?.body ?? 'null')))

describe('AgentHistory with projects', () => {
  it('groups chats under their project and Unfiled', () => {
    render(<Harness />)
    expect(screen.getByLabelText('Project Dentists')).toBeTruthy()
    fireEvent.click(within(screen.getByLabelText('Project Dentists')).getByRole('button', { name: /^Dentists/ }))
    expect(within(screen.getByLabelText('Chats in Dentists')).getByText('Dentist ICP')).toBeTruthy()
    expect(within(screen.getByLabelText('Unfiled chats')).getByText('Roofing plan')).toBeTruthy()
    expect(within(screen.getByLabelText('Unfiled chats')).queryByText('Dentist ICP')).toBeNull()
  })

  it('dropping a chat on a project files it (highlighting the target while over it)', async () => {
    render(<Harness />)
    const row = screen.getByLabelText('Project Roofers')
    const data = dt({ [CHAT_DRAG]: C1 })
    fireEvent.dragOver(row, { dataTransfer: data })
    expect(row.className).toContain('ring-primary')
    fireEvent.drop(row, { dataTransfer: data })
    await waitFor(() => expect(calls('PUT', `/api/agent/conversations/${C1}/project`)).toEqual([{ project_id: P2 }]))
    expect(within(screen.getByLabelText('Chats in Roofers')).getByText('Roofing plan')).toBeTruthy()
  })

  it('dropping a chat on Unfiled unfiles it', async () => {
    render(<Harness />)
    const unfiled = screen.getByLabelText('Unfiled chats')
    fireEvent.dragOver(unfiled, { dataTransfer: dt({ [CHAT_DRAG]: C2 }) })
    fireEvent.drop(unfiled, { dataTransfer: dt({ [CHAT_DRAG]: C2 }) })
    await waitFor(() => expect(calls('PUT', `/api/agent/conversations/${C2}/project`)).toEqual([{ project_id: null }]))
    await waitFor(() => expect(within(screen.getByLabelText('Unfiled chats')).getByText('Dentist ICP')).toBeTruthy())
  })

  it('a failed move puts the chat back and says why', async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: 'project_not_found' }, { status: 404 }))
    render(<Harness />)
    fireEvent.drop(screen.getByLabelText('Project Roofers'), { dataTransfer: dt({ [CHAT_DRAG]: C1 }) })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(within(screen.getByLabelText('Unfiled chats')).getByText('Roofing plan')).toBeTruthy()
  })

  it('dropping OS files on a project uploads them (sign → storage → finalize)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/files/sign')) return Response.json({ path: `${P2}/abc.csv`, token: 'tok', upload_ticket: 't' })
      if (url.endsWith('/files')) return Response.json({ item: { id: 'f1', name: 'leads.csv' } }, { status: 201 })
      return Response.json({ ok: true })
    })
    render(<Harness />)
    const file = new File(['email\na@b.co'], 'leads.csv', { type: 'text/csv' })
    const row = screen.getByLabelText('Project Roofers')
    fireEvent.dragOver(row, { dataTransfer: dt({}, [file]) })
    fireEvent.drop(row, { dataTransfer: dt({}, [file]) })
    await waitFor(() => expect(calls('POST', `/api/agent/projects/${P2}/files`)).toHaveLength(1))
    expect(calls('POST', `/api/agent/projects/${P2}/files/sign`)).toEqual([{ filename: 'leads.csv', size: file.size }])
    const [path, token, body, opts] = storage.uploadToSignedUrl.mock.calls[0]
    expect([path, token, opts]).toEqual([`${P2}/abc.csv`, 'tok', { contentType: 'text/csv' }])
    // The raw bytes, not the File: storage-js would send a File as multipart with the browser's type.
    expect(body).not.toBeInstanceOf(File)
    expect((body as ArrayBuffer).byteLength).toBe(file.size)
    expect(calls('POST', `/api/agent/projects/${P2}/files`)[0]).toMatchObject({ storage_path: `${P2}/abc.csv`, filename: 'leads.csv', upload_ticket: 't' })
  })

  it('uploads with our content type, not the browser guess (the bucket allows only supported types)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/files/sign')) return Response.json({ path: `${P2}/abc.md`, token: 'tok', upload_ticket: 't' })
      if (url.endsWith('/files')) return Response.json({ item: { id: 'f1', name: 'notes.md' } }, { status: 201 })
      return Response.json({ ok: true })
    })
    render(<Harness />)
    const file = new File(['# hi'], 'notes.md', { type: '' })
    fireEvent.drop(screen.getByLabelText('Project Roofers'), { dataTransfer: dt({}, [file]) })
    await waitFor(() => expect(storage.uploadToSignedUrl).toHaveBeenCalled())
    expect(storage.uploadToSignedUrl.mock.calls[0][3]).toEqual({ contentType: 'text/markdown' })
  })

  it('an unsupported file is refused before any upload', async () => {
    render(<Harness />)
    const file = new File(['x'], 'tool.exe')
    fireEvent.drop(screen.getByLabelText('Project Roofers'), { dataTransfer: dt({}, [file]) })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/files'))).toBe(false)
  })

  it('dragging a project onto another reorders them', async () => {
    render(<Harness />)
    const target = screen.getByLabelText('Project Dentists')
    target.getBoundingClientRect = () => ({ top: 0, height: 32, bottom: 32, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.dragOver(target, { dataTransfer: dt({ [PROJECT_DRAG]: P2 }), clientY: 4 })
    fireEvent.drop(target, { dataTransfer: dt({ [PROJECT_DRAG]: P2 }), clientY: 4 })
    await waitFor(() => expect(calls('PUT', '/api/agent/projects/order')).toEqual([{ ids: [P2, P1] }]))
    const rows = screen.getAllByLabelText(/^Project /)
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['Project Roofers', 'Project Dentists'])
  })

  it('"Move to project" in the chat menu files it without dragging', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Options for Roofing plan' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Move to project/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('option', { name: /Dentists/ }))
    await waitFor(() => expect(calls('PUT', `/api/agent/conversations/${C1}/project`)).toEqual([{ project_id: P1 }]))
  })

  it('"Move down" in the project menu reorders without dragging', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Options for project Dentists' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Move down/ }))
    await waitFor(() => expect(calls('PUT', '/api/agent/projects/order')).toEqual([{ ids: [P2, P1] }]))
  })

  it('New project creates one from the inline field', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/agent/projects' && init?.method === 'POST' ? Response.json({ project: project('0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b03', 'Gyms', 2) }, { status: 201 }) : Response.json({ ok: true })
    )
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    const input = await screen.findByLabelText('Project name')
    fireEvent.change(input, { target: { value: 'Gyms' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(calls('POST', '/api/agent/projects')).toEqual([{ name: 'Gyms' }])
    expect(await screen.findByLabelText('Project Gyms')).toBeTruthy()
  })
})
