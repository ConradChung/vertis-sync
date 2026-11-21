/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// No live writes: every DB/client module is stubbed, and the raw client throws.
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => { throw new Error('no db in tests') } }))
const m = vi.hoisted(() => ({
  ackAlerts: vi.fn(),
  getDeal: vi.fn(),
  getStages: vi.fn(),
  setStage: vi.fn(),
  addActivity: vi.fn(),
  insertTask: vi.fn(),
  pushTask: vi.fn(),
  after: vi.fn(),
  exportCandidates: vi.fn(),
  createList: vi.fn(),
  appendItems: vi.fn(),
  createProject: vi.fn(),
  addNote: vi.fn(),
  findProject: vi.fn(),
}))
vi.mock('@/lib/alertsStore', () => ({ ackAlerts: m.ackAlerts }))
vi.mock('@/lib/crm/service', () => ({ getDeal: m.getDeal, getStages: m.getStages, setStage: m.setStage, addActivity: m.addActivity }))
vi.mock('@/lib/tasks/store', () => ({ insertTask: m.insertTask }))
vi.mock('@/lib/tasks/sync', () => ({ pushTask: m.pushTask }))
vi.mock('next/server', async (orig) => ({ ...(await orig<object>()), after: m.after }))
vi.mock('@/lib/influencers/store', () => ({ exportCandidates: m.exportCandidates }))
vi.mock('@/lib/leads/lists/store', () => ({ createList: m.createList, appendItems: m.appendItems }))
vi.mock('@/lib/agent/projects', () => {
  class ProjectConflictError extends Error {}
  return { createProject: m.createProject, addNote: m.addNote, ProjectConflictError }
})
vi.mock('@/lib/mcp/db', async (orig) => ({
  ...(await orig<object>()),
  sb: () => ({ from: () => ({ select: () => ({ ilike: () => ({ is: () => ({ limit: () => ({ maybeSingle: m.findProject }) }) }) }) }) }),
}))

import { internalTools } from '@/lib/mcp/tools/internal'
import { McpUserError } from '@/lib/mcp/sanitize'

const tool = (n: string) => internalTools.find((t) => t.name === n)!
const run = (n: string, args: Record<string, unknown>) => tool(n).run(tool(n).input.parse(args) as never)
const DEAL = '11111111-1111-4111-8111-111111111111'
const STAGES = ['Contacted', 'Replied', 'Meeting', 'Won', 'Lost'].map((name, position) => ({ campaign_id: '_default', name, position }))

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
})

describe('group B tools', () => {
  it('every tool is a write, not read-only, never destructive, and takes idempotency_key', () => {
    expect(internalTools.map((t) => t.name).sort()).toEqual([
      'lume_ack_alert', 'lume_add_deal_note', 'lume_create_review_set', 'lume_create_task', 'lume_draft_icp_brief', 'lume_draft_outbound_plan', 'lume_move_deal_stage',
    ])
    for (const t of internalTools) {
      expect(t.cls).toBe('write')
      expect(t.annotations.readOnlyHint).toBe(false)
      expect(t.annotations.destructiveHint).toBe(false)
      expect(t.annotations.openWorldHint).toBe(false)
      expect(Object.keys(t.input.shape)).toContain('idempotency_key')
    }
  })

  it('lume_ack_alert acks only the given ids, deduped, marked via mcp', async () => {
    const a = '22222222-2222-4222-8222-222222222222'
    m.ackAlerts.mockResolvedValue([a])
    const out: any = await run('lume_ack_alert', { alert_ids: [a, a.toUpperCase(), '33333333-3333-4333-8333-333333333333'] })
    expect(m.ackAlerts).toHaveBeenCalledWith({ ids: [a, '33333333-3333-4333-8333-333333333333'] }, null, 'mcp')
    expect(out.data).toEqual({ acked: 1, acked_ids: [a], skipped: 1 })
    expect(() => tool('lume_ack_alert').input.parse({ all: true })).toThrow()
  })

  describe('lume_move_deal_stage', () => {
    beforeEach(() => {
      m.getDeal.mockResolvedValue({ id: DEAL, stage: 'Contacted', campaign_id: 'c1' })
      m.getStages.mockResolvedValue(STAGES)
    })
    it('moves with source mcp and via mcp', async () => {
      m.setStage.mockResolvedValue('Contacted')
      const out: any = await run('lume_move_deal_stage', { deal_id: DEAL, stage: 'Meeting', reason: 'booked' })
      expect(m.setStage).toHaveBeenCalledWith(DEAL, 'Meeting', 'mcp', 'booked', { via: 'mcp' })
      expect(out.data).toEqual({ deal_id: DEAL, changed: true, from: 'Contacted', to: 'Meeting' })
    })
    it.each(['Won', 'Lost'])('refuses %s (owner approval only) without writing', async (stage) => {
      await expect(run('lume_move_deal_stage', { deal_id: DEAL, stage, reason: 'x' })).rejects.toThrow(/owner's approval/)
      expect(m.setStage).not.toHaveBeenCalled()
    })
    it('unknown stage lists the valid ones; same stage is a no-op', async () => {
      await expect(run('lume_move_deal_stage', { deal_id: DEAL, stage: 'Nope' })).rejects.toThrow(/Valid stages: Contacted, Replied/)
      const out: any = await run('lume_move_deal_stage', { deal_id: DEAL, stage: 'Contacted' })
      expect(out.data.changed).toBe(false)
      expect(m.setStage).not.toHaveBeenCalled()
    })
    it('missing deal is a user error', async () => {
      m.getDeal.mockResolvedValue(null)
      await expect(run('lume_move_deal_stage', { deal_id: DEAL, stage: 'Meeting' })).rejects.toBeInstanceOf(McpUserError)
    })
  })

  it('lume_add_deal_note writes a note activity with source mcp', async () => {
    m.getDeal.mockResolvedValue({ id: DEAL })
    m.addActivity.mockResolvedValue({ id: 'act1' })
    const out: any = await run('lume_add_deal_note', { deal_id: DEAL, text: ' called back ' })
    expect(m.addActivity).toHaveBeenCalledWith({ deal_id: DEAL, kind: 'note', source: 'mcp', payload: { text: 'called back', via: 'mcp' } })
    expect(out.refs).toEqual({ deal_id: DEAL, activity_id: 'act1' })
  })

  it('lume_create_task: created_by mcp, never an action, Linear sync scheduled after', async () => {
    m.insertTask.mockImplementation(async (row: any) => ({ id: 't1', ...row }))
    const out: any = await run('lume_create_task', { title: 'Follow up', due: '2026-12-01' })
    const row = m.insertTask.mock.calls[0][0]
    expect(row).toMatchObject({ title: 'Follow up', created_by: 'mcp', action_kind: null, action_payload: null, conversation_id: null, all_day: true })
    expect(m.after).toHaveBeenCalledTimes(1)
    expect(m.pushTask).not.toHaveBeenCalled() // only inside after()
    expect(out.data.task_id).toBe('t1')
    expect(Object.keys(tool('lume_create_task').input.shape)).not.toContain('action')
    await expect(run('lume_create_task', { title: 'x', due: 'next tuesday' })).rejects.toThrow(/due must be/)
  })

  describe('lume_create_review_set', () => {
    it('builds a list from verified reactors, rows marked mcp, reactors not marked exported', async () => {
      m.exportCandidates.mockResolvedValue([{ id: 'r1', name: 'Ann', title: 'COO', company_name: 'Acme PM', company_website: 'acme.com', linkedin_url: 'https://linkedin.com/in/ann', city: null, state: 'TX', country: 'US', door_count: 900, reacted_to: ['inf'] }])
      m.createList.mockResolvedValue({ id: 'L1' })
      m.appendItems.mockResolvedValue({ added: 1, duplicates: 0, skipped: 0, over_cap: 0, item_count: 1 })
      const out: any = await run('lume_create_review_set', { name: 'PM 700+', min_doors: 700 })
      expect(m.exportCandidates).toHaveBeenCalledWith({ verified_only: true, min_door_count: 700, only_new: true, influencer_slugs: undefined }, 500)
      expect(m.createList).toHaveBeenCalledWith({ name: 'PM 700+', notes: null, created_by: 'mcp' })
      const rows = m.appendItems.mock.calls[0][1]
      expect(rows[0].source).toBe('mcp')
      expect(rows[0].cells['Door Count']).toBe('900')
      expect(out.data).toMatchObject({ list_id: 'L1', matched: 1, added: 1 })
    })
    it('creates nothing when no reactor matches', async () => {
      m.exportCandidates.mockResolvedValue([])
      await expect(run('lume_create_review_set', { name: 'x' })).rejects.toThrow(/nothing was created/)
      expect(m.createList).not.toHaveBeenCalled()
    })
  })

  describe('drafts', () => {
    it('reuses the MCP drafts project and titles the note', async () => {
      m.findProject.mockResolvedValue({ data: { id: 'P1' }, error: null })
      m.addNote.mockResolvedValue({ id: 'N1', name: 'ICP brief · PM mid-market' })
      const out: any = await run('lume_draft_icp_brief', { title: 'PM mid-market', content: '# ICP' })
      expect(m.createProject).not.toHaveBeenCalled()
      expect(m.addNote).toHaveBeenCalledWith('P1', 'ICP brief · PM mid-market', '# ICP')
      expect(out.refs).toEqual({ project_id: 'P1', note_id: 'N1' })
    })
    it('creates the project on first use', async () => {
      m.findProject.mockResolvedValue({ data: null, error: null })
      m.createProject.mockResolvedValue({ id: 'P2' })
      m.addNote.mockResolvedValue({ id: 'N2', name: 'Outbound plan · Q1' })
      await run('lume_draft_outbound_plan', { title: 'Q1', content: 'plan' })
      expect(m.createProject.mock.calls[0][0].name).toBe('MCP drafts')
      expect(m.addNote).toHaveBeenCalledWith('P2', 'Outbound plan · Q1', 'plan')
    })
  })
})
