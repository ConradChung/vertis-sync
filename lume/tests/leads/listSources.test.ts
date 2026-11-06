import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  loadAttachmentLeads: vi.fn(),
  fileInConversation: vi.fn(),
  loadSourceRows: vi.fn(),
  getExport: vi.fn(),
  exportRows: vi.fn(),
  keptRows: vi.fn(),
  reviewSetInScope: vi.fn(),
}))
vi.mock('@/lib/review/attachmentSource', () => ({ loadAttachmentLeads: m.loadAttachmentLeads }))
vi.mock('@/lib/agent/chatFiles', () => ({ fileInConversation: m.fileInConversation }))
vi.mock('@/lib/apollo/source', () => ({ loadSourceRows: m.loadSourceRows, SourceError: class extends Error { constructor(public status: number, public code: string) { super(code) } } }))
vi.mock('@/lib/influencers/store', () => ({ getExport: m.getExport, exportRows: m.exportRows }))
vi.mock('@/lib/leads/lists/reviewRows', () => ({ keptRows: m.keptRows, reviewSetInScope: m.reviewSetInScope }))

import { rowsFromSource, SourceRefused } from '@/lib/leads/lists/sources'

const FILE = '11111111-1111-4111-8111-111111111111'
const CONV = '22222222-2222-4222-8222-222222222222'

beforeEach(() => vi.clearAllMocks())

describe('rowsFromSource', () => {
  it('attachment: scoped to the chat, mapped columns, raw kept, source attachment', async () => {
    m.fileInConversation.mockResolvedValue(true)
    m.loadAttachmentLeads.mockResolvedValue({ label: 'f.xlsx · S1', rows: [{ 'Work Email': 'a@a.co', Co: 'A' }], normalisable: () => ({ email: 'a@a.co', companyname: 'A' }), mapping: { email: 'Work Email', company: 'Co' }, unmapped: [] })
    const r = await rowsFromSource({ kind: 'attachment', file_id: FILE }, { conversationId: CONV, by: 'agent' })
    expect(r.rows).toEqual([{ raw: { 'Work Email': 'a@a.co', Co: 'A' }, item: expect.objectContaining({ email: 'a@a.co', company: 'A' }), source: 'attachment', cells: { 'Work Email': 'a@a.co', Co: 'A' } }])
    expect(r.label).toBe('f.xlsx · S1')
    m.fileInConversation.mockResolvedValue(false)
    await expect(rowsFromSource({ kind: 'attachment', file_id: FILE }, { conversationId: CONV, by: 'agent' })).rejects.toBeInstanceOf(SourceRefused)
  })

  it('review set: its kept rows; actor run: the run rows normalised', async () => {
    m.keptRows.mockResolvedValue([{ item: { email: 'k@k.co' }, raw: { x: 1 } }])
    m.reviewSetInScope.mockResolvedValue(true)
    expect((await rowsFromSource({ kind: 'review_set', set_id: FILE }, { by: 'agent', conversationId: CONV })).rows[0]).toMatchObject({ source: 'review_set', raw: { x: 1 } })
    expect(m.reviewSetInScope).toHaveBeenCalledWith(FILE, CONV, null)
    // The agent may only take a review set from this chat (or its project's chats).
    m.reviewSetInScope.mockResolvedValue(false)
    await expect(rowsFromSource({ kind: 'review_set', set_id: FILE }, { by: 'agent', conversationId: CONV })).rejects.toBeInstanceOf(SourceRefused)
    await expect(rowsFromSource({ kind: 'review_set', set_id: FILE }, { by: 'agent' })).rejects.toBeInstanceOf(SourceRefused)
    m.loadSourceRows.mockResolvedValue({ label: 'run abc', rows: [{ title: 'Roofer Co', website: 'roof.co', phone: '555' }] })
    const run = await rowsFromSource({ kind: 'actor_run', run_id: 'abcdefgh12' }, { by: 'agent' })
    expect(m.loadSourceRows).toHaveBeenCalledWith({ kind: 'run', id: 'abcdefgh12' })
    expect(run.rows[0]).toMatchObject({ source: 'actor_run', item: expect.objectContaining({ domain: 'roof.co' }) })
  })

  it('influencer export: each reactor as a person lead with LinkedIn, title and company', async () => {
    m.getExport.mockResolvedValue({ id: FILE, reactor_ids: [7] })
    m.exportRows.mockResolvedValue([{ id: 7, name: 'Jane Doe', linkedin_url: 'https://linkedin.com/in/jane', title: 'Owner', company_name: 'Doe PM', company_website: 'doepm.com', location: null, city: 'Austin', state: 'TX', country: 'US', door_count: 900, reacted_to: ['bob'] }])
    const r = await rowsFromSource({ kind: 'influencer_export', export_id: FILE }, { by: 'agent' })
    expect(r.rows[0]).toMatchObject({ source: 'influencer_export', item: { first_name: 'Jane', last_name: 'Doe', title: 'Owner', company: 'Doe PM', linkedin_url: 'https://linkedin.com/in/jane', city: 'Austin' } })
    m.getExport.mockResolvedValue(null)
    await expect(rowsFromSource({ kind: 'influencer_export', export_id: FILE }, { by: 'agent' })).rejects.toBeInstanceOf(SourceRefused)
  })

  it('inline rows: at most 200, tagged agent (or manual from the page)', async () => {
    const r = await rowsFromSource({ kind: 'inline', rows: [{ name: 'A', email: 'a@a.co' }] }, { by: 'owner' })
    expect(r.rows[0]).toMatchObject({ source: 'manual', item: { name: 'A', email: 'a@a.co' }, raw: { name: 'A', email: 'a@a.co' } })
    expect((await rowsFromSource({ kind: 'inline', rows: [{ email: 'b@b.co' }] }, { by: 'agent' })).rows[0].source).toBe('agent')
    await expect(rowsFromSource({ kind: 'inline', rows: Array.from({ length: 201 }, () => ({ email: 'x@y.co' })) }, { by: 'agent' })).rejects.toBeInstanceOf(SourceRefused)
  })

  it('paste: TSV parsed and mapped, tagged manual', async () => {
    const r = await rowsFromSource({ kind: 'paste', text: 'Email\tCompany\na@a.co\tA\n' }, { by: 'owner' })
    expect(r.rows[0]).toMatchObject({ source: 'manual', item: { email: 'a@a.co', company: 'A' } })
    await expect(rowsFromSource({ kind: 'paste', text: '' }, { by: 'owner' })).rejects.toBeInstanceOf(SourceRefused)
  })
})
