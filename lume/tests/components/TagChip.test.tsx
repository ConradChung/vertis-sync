// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { TagChip, TagFilter } from '@/components/tags/TagChip'

const KAS = { id: '466d9a53-6450-49df-a063-8e66437efa8b', name: 'Kaspen / Zenport' }
const JOBS = { id: '5b54bc53-ac4a-49a3-b13a-a299b2d6b38f', name: 'Job search / GTM roles' }
const ROW = '0b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3'

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === '/api/tags' && (init?.method ?? 'GET') === 'GET') return Response.json({ tags: [JOBS, KAS] })
  if (url === '/api/tags') {
    const b = JSON.parse(String(init?.body))
    return Response.json({ item: { id: b.id, vertical_id: b.vertical_id } })
  }
  return Response.json({})
})

const wrap = (ui: React.ReactNode) => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>)

beforeEach(() => {
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TagChip', () => {
  it('shows the tag, or Untagged; read-only without a table', () => {
    wrap(<TagChip table={null} id={ROW} verticalId={KAS.id} name="Kaspen / Zenport" />)
    expect(screen.getByTitle('Tag: Kaspen / Zenport')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    wrap(<TagChip table="job_batches" id={ROW} verticalId={null} />)
    expect(screen.getByRole('button', { name: /Tag: Untagged/ })).toBeTruthy()
  })

  it('picking a tag PATCHes /api/tags and shows it; the click does not reach a clickable parent', async () => {
    const onChanged = vi.fn()
    const parent = vi.fn()
    wrap(
      <div onClick={parent}>
        <TagChip table="job_batches" id={ROW} verticalId={KAS.id} name="Kaspen / Zenport" onChanged={onChanged} />
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: /Tag: Kaspen \/ Zenport/ }))
    const option = await screen.findByRole('button', { name: 'Job search / GTM roles' })
    fireEvent.click(option)
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(JOBS.id))
    const patch = fetchMock.mock.calls.find(([, i]) => i?.method === 'PATCH')!
    expect(JSON.parse(String(patch[1]!.body))).toEqual({ table: 'job_batches', id: ROW, vertical_id: JOBS.id })
    expect(await screen.findByRole('button', { name: /Tag: Job search \/ GTM roles/ })).toBeTruthy()
    expect(parent).not.toHaveBeenCalled()
  })

  it('Untagged clears the tag', async () => {
    wrap(<TagChip table="lume_tasks" id={ROW} verticalId={KAS.id} name="Kaspen / Zenport" />)
    fireEvent.click(screen.getByRole('button', { name: /Tag: Kaspen/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Untagged' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(true))
    const patch = fetchMock.mock.calls.find(([, i]) => i?.method === 'PATCH')!
    expect(JSON.parse(String(patch[1]!.body)).vertical_id).toBeNull()
  })
})

describe('TagFilter', () => {
  it('All plus one pill per tag; hidden with a single option', () => {
    const onChange = vi.fn()
    const { rerender } = wrap(<TagFilter options={[{ id: KAS.id, name: 'Kaspen', count: 2 }, { id: null, name: 'Untagged', count: 1 }]} value="all" onChange={onChange} />)
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['All3', 'Kaspen2', 'Untagged1'])
    fireEvent.click(screen.getByRole('radio', { name: /Kaspen/ }))
    expect(onChange).toHaveBeenCalledWith(KAS.id)
    rerender(<TagFilter options={[{ id: KAS.id, name: 'Kaspen', count: 2 }]} value="all" onChange={onChange} />)
    expect(screen.queryByRole('radio')).toBeNull()
  })
})
