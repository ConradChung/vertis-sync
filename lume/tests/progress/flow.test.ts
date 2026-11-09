import { describe, expect, it } from 'vitest'
import type { GateKind, GateRow, JobProgress } from '@/lib/db/types'
import { buildFlow, focusStep, type FlowNode, type StepId } from '@/lib/progress/flow'

const JOB = '7db3d841-252c-4572-95ec-bc110727df8d'
const job = (o: Partial<JobProgress> = {}): JobProgress => ({
  id: JOB, filename: 'uk-agents.csv', display_name: null, created_at: '2026-11-05T10:00:00Z', status: 'completed', total_rows: 1000, processed_rows: 1000,
  eta_seconds: null, eta_updated_at: null, eta_stage: null, eta_validate_seconds: null, eta_enrich_seconds: null,
  enrich: false, enrich_started: false, enriched_rows: 0, finder_status: null, rows_missing_email: null, emails_found: null,
  instantly_status: null, instantly_campaign_id: null, instantly_campaign_name: null, location_barrier: false, company_barrier: true, company_strict: false,
  instantly_pushed: 0, instantly_pushed_nolocation: 0, source: 'telegram',
  counts: { pending: 0, valid: 800, invalid: 150, error: 30, no_email: 20 },
  ...o,
})
const gate = (kind: GateKind, o: Partial<GateRow> = {}): GateRow => ({
  kind, target_table: 'validation_jobs', target_id: JOB, title: `t ${kind}`, subtitle: null, actions: [], counts: {}, telegram_message_id: null, created_at: '2026-11-05T10:00:00Z', ...o,
})
const states = (nodes: FlowNode[]) => Object.fromEntries(nodes.map((n) => [n.id, n.state])) as Record<StepId, FlowNode['state']>
const ids = (nodes: FlowNode[]) => nodes.map((n) => n.id)
const byId = (nodes: FlowNode[], id: StepId) => nodes.find((n) => n.id === id)!

describe('buildFlow', () => {
  it('a CSV at the approval gate: Imported done, Approved is your move with the gate, the rest not started', () => {
    const g = gate('ingest_approval', { target_table: 'telegram_ingests', subtitle: 'leads.csv · from Leadsfriday · email column email', counts: { row_count: 5272 }, actions: ['approve', 'approve_enrich', 'deny'] })
    const nodes = buildFlow({ job: null, gates: [g] })
    expect(ids(nodes)).toEqual(['imported', 'approved', 'validate', 'enrich', 'campaign', 'review', 'push', 'launch'])
    expect(states(nodes)).toMatchObject({ imported: 'done', approved: 'needs_you', validate: 'todo', launch: 'todo' })
    expect(byId(nodes, 'approved').gate).toBe(g)
    expect(byId(nodes, 'imported').metrics).toEqual(['5,272 rows', 'from Leadsfriday'])
    expect(focusStep(nodes)).toBe('approved')
  })

  it('validating: Validate is active with a bar, ETA and valid / invalid; no Find emails or Enrich node when not involved', () => {
    const nodes = buildFlow({
      job: job({ status: 'processing', processed_rows: 400, eta_seconds: 3600, eta_updated_at: '2026-11-05T10:00:00Z', eta_stage: 'validating', counts: { pending: 600, valid: 300, invalid: 100, error: 0, no_email: 0 } }),
      gates: [],
      now: Date.parse('2026-11-05T10:00:00Z'),
    })
    expect(ids(nodes)).toEqual(['imported', 'approved', 'validate', 'campaign', 'review', 'push', 'launch'])
    const v = byId(nodes, 'validate')
    expect(v.state).toBe('active')
    expect(v.progress).toEqual({ done: 400, total: 1000 })
    expect(v.metrics).toEqual(['400 / 1,000', '300 valid', '25% invalid'])
    expect(v.eta).toBe('Validating · ~1 h left')
    expect(focusStep(nodes)).toBe('validate')
  })

  it('finder prompt: Find emails is your move, Validate waits', () => {
    const g = gate('finder_decision')
    const nodes = buildFlow({ job: job({ status: 'pending', processed_rows: 0, finder_status: 'awaiting_decision', rows_missing_email: 120, counts: { pending: 1000, valid: 0, invalid: 0, error: 0, no_email: 0 } }), gates: [g] })
    expect(states(nodes)).toMatchObject({ finder: 'needs_you', validate: 'todo' })
    expect(byId(nodes, 'finder').gate).toBe(g)
    expect(byId(nodes, 'finder').metrics).toEqual(['120 missing'])
  })

  it('a stalled job: Validate is your move (Resume)', () => {
    const g = gate('stall')
    const nodes = buildFlow({ job: job({ status: 'processing', processed_rows: 400, counts: { pending: 600, valid: 300, invalid: 100, error: 0, no_email: 0 } }), gates: [g] })
    expect(byId(nodes, 'validate')).toMatchObject({ state: 'needs_you', gate: g })
    expect(byId(nodes, 'validate').metrics[0]).toBe('stalled')
  })

  it('enriching after validation: Validate done, Enrich active (enriched of valid)', () => {
    const nodes = buildFlow({ job: job({ status: 'processing', enrich: true, enrich_started: true, enriched_rows: 200 }), gates: [] })
    expect(states(nodes)).toMatchObject({ validate: 'done', enrich: 'active' })
    expect(byId(nodes, 'enrich').progress).toEqual({ done: 200, total: 800 })
    expect(byId(nodes, 'approved').metrics).toEqual(['+ enrich'])
  })

  it('done with enrichment: cities found and the rest without one', () => {
    const nodes = buildFlow({ job: job({ enrich: true, enrich_started: true, enriched_rows: 700 }), gates: [] })
    expect(byId(nodes, 'enrich')).toMatchObject({ state: 'done', metrics: ['700 enriched', '100 no city'] })
  })

  it('campaign pick waiting: Campaign is your move', () => {
    const g = gate('campaign_choice')
    const nodes = buildFlow({ job: job({ instantly_status: 'awaiting_campaign' }), gates: [g] })
    expect(states(nodes)).toMatchObject({ validate: 'done', campaign: 'needs_you', review: 'todo', push: 'todo' })
    expect(focusStep(nodes)).toBe('campaign')
  })

  it('push review: Campaign done with the no-location sibling, Review is your move with the barriers', () => {
    const g = gate('push_review')
    const nodes = buildFlow({
      job: job({ instantly_status: 'configuring', instantly_campaign_id: 'c1', instantly_campaign_name: 'UK agents', instantly_campaign_name_nolocation: 'UK agents — No Location', location_barrier: true }),
      gates: [g],
    })
    expect(byId(nodes, 'campaign')).toMatchObject({ state: 'done', metrics: ['UK agents', '+ UK agents — No Location'] })
    expect(byId(nodes, 'review')).toMatchObject({ state: 'needs_you', gate: g, metrics: ['location on', 'company on'] })
  })

  it('push confirmation waiting (lume_action): Review done, Push is your move with that confirmation', () => {
    const a = gate('lume_action', { target_table: 'pending_actions', target_id: '11111111-1111-4111-8111-111111111111', title: 'push_to_instantly', counts: { job_id: JOB } })
    const nodes = buildFlow({ job: job({ instantly_status: 'reviewing_company', instantly_campaign_name: 'UK agents' }), gates: [a] })
    expect(states(nodes)).toMatchObject({ review: 'done', push: 'needs_you' })
    expect(byId(nodes, 'push').gate).toBe(a)
  })

  it('pushed: Push done with both counts; Launch done only when the campaign is active', () => {
    const j = job({ instantly_status: 'done', instantly_campaign_name: 'UK agents', instantly_pushed: 640, instantly_pushed_nolocation: 90 })
    const draft = buildFlow({ job: j, gates: [], campaignStatus: 'draft' })
    expect(byId(draft, 'push')).toMatchObject({ state: 'done', metrics: ['640 pushed', '90 no-location'] })
    expect(byId(draft, 'launch')).toMatchObject({ state: 'todo', metrics: ['draft'] })
    expect(byId(buildFlow({ job: j, gates: [], campaignStatus: 'active' }), 'launch').state).toBe('done')
    expect(focusStep(draft)).toBe('push')
  })

  it('cancelled push: Campaign → Launch skipped', () => {
    const nodes = buildFlow({ job: job({ instantly_status: 'cancelled' }), gates: [] })
    expect(states(nodes)).toMatchObject({ validate: 'done', campaign: 'skipped', review: 'skipped', push: 'skipped', launch: 'skipped' })
  })

  it('failed validation: Validate failed and focused', () => {
    const nodes = buildFlow({ job: job({ status: 'failed', processed_rows: 10, counts: { pending: 990, valid: 10, invalid: 0, error: 0, no_email: 0 } }), gates: [] })
    expect(byId(nodes, 'validate').state).toBe('failed')
    expect(focusStep(nodes)).toBe('validate')
  })

  it('push error: Push failed', () => {
    expect(byId(buildFlow({ job: job({ instantly_status: 'error', instantly_campaign_name: 'X' }), gates: [] }), 'push').state).toBe('failed')
  })

  it('lead-bank routing (optional preview fields): Push reads banked instead of pushed; missing route stays direct', () => {
    const a = gate('lume_action', { target_table: 'pending_actions', target_id: '11111111-1111-4111-8111-111111111111', title: 'push_to_instantly', counts: { job_id: JOB } })
    const j = job({ instantly_status: 'reviewing_company', instantly_campaign_name: 'UK agents' })
    expect(byId(buildFlow({ job: j, gates: [a], route: { route: 'bank', banked_estimate: 4563, threshold: 1000 } }), 'push').metrics).toEqual(['confirm', '4,563 → lead bank'])
    expect(byId(buildFlow({ job: j, gates: [a], route: {} }), 'push').metrics).toEqual(['confirm'])
    expect(byId(buildFlow({ job: j, gates: [a] }), 'push').metrics).toEqual(['confirm'])
    const banked = job({ instantly_status: 'done', instantly_campaign_name: 'UK agents', instantly_banked: 4563 })
    expect(byId(buildFlow({ job: banked, gates: [] }), 'push')).toMatchObject({ state: 'done', metrics: ['4,563 banked'] })
  })
})
