import { describe, expect, it } from 'vitest'
import type { GateKind, GateRow, RunRow } from '@/lib/db/types'
import { defaultRunId, fromRunRow, gatesForRun, ingestRuns, mergeRuns, parseRunParam, resolveGateLink, runOfGate, runStatus, selectRun, stepOfGate } from '@/lib/progress/runs'

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-1111-4111-8111-111111111111'
const C = 'cccccccc-1111-4111-8111-111111111111'
const I = 'dddddddd-1111-4111-8111-111111111111'
const row = (id: string, o: Partial<RunRow> = {}): RunRow => ({
  id, filename: `${id.slice(0, 4)}.csv`, display_name: null, status: 'completed', total_rows: 100, processed_rows: 100, valid_count: 80, enrich: false,
  finder_status: null, instantly_status: null, source: 'telegram', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', vertical_id: null, ...o,
})
const gate = (kind: GateKind, target: string, o: Partial<GateRow> = {}): GateRow => ({
  kind, target_table: 'validation_jobs', target_id: target, title: 't', subtitle: null, actions: [], counts: {}, telegram_message_id: null, created_at: '2026-11-08T00:00:00Z', ...o,
})

describe('runOfGate / stepOfGate', () => {
  it('maps job gates to their job, ingests to ingest:<id>, push / launch confirmations to their job_id; others to no run', () => {
    expect(runOfGate(gate('campaign_choice', A))).toBe(A)
    expect(runOfGate(gate('ingest_approval', I, { target_table: 'telegram_ingests' }))).toBe(`ingest:${I}`)
    expect(runOfGate(gate('lume_action', C, { target_table: 'pending_actions', title: 'push_to_instantly', counts: { job_id: A } }))).toBe(A)
    expect(runOfGate(gate('lume_action', C, { target_table: 'pending_actions', title: 'assign_leads', counts: { job_id: A } }))).toBeNull()
    expect(runOfGate(gate('jobs_review', C, { target_table: 'job_batches' }))).toBeNull()
    expect(runOfGate(gate('lfo_count', C, { target_table: 'apollo_orders' }))).toBeNull()
    expect(stepOfGate(gate('push_review', A))).toBe('review')
    expect(stepOfGate(gate('lume_action', C, { title: 'launch_campaign' }))).toBe('launch')
  })
})

describe('default run', () => {
  const runs = mergeRuns(
    [
      fromRunRow(row(A, { updated_at: '2026-11-09T08:00:00Z' })), // newest, done
      fromRunRow(row(B, { updated_at: '2026-11-07T00:00:00Z', status: 'processing' })), // running
      fromRunRow(row(C, { updated_at: '2026-11-08T00:00:00Z' })), // waiting on a gate
    ],
    []
  )
  it('prefers the most recently active run that is running or waiting on you', () => {
    expect(defaultRunId(runs, [gate('campaign_choice', C)])).toBe(C)
    expect(defaultRunId(runs, [])).toBe(B)
  })
  it('falls back to the most recently active run', () => {
    expect(defaultRunId(mergeRuns([fromRunRow(row(A, { updated_at: '2026-11-01T00:00:00Z' })), fromRunRow(row(C, { updated_at: '2026-11-05T00:00:00Z' }))], []), [])).toBe(C)
    expect(defaultRunId([], [])).toBeNull()
  })
  it('a CSV waiting at approval is a run too', () => {
    const g = gate('ingest_approval', I, { target_table: 'telegram_ingests', subtitle: 'new.csv · from Ana · email column email', counts: { row_count: 42 }, created_at: '2026-11-09T09:00:00Z' })
    const all = mergeRuns(runs, ingestRuns([g]))
    expect(all[0]).toMatchObject({ id: `ingest:${I}`, kind: 'ingest', title: 'new.csv', total_rows: 42 })
    expect(defaultRunId(all, [g])).toBe(`ingest:${I}`)
    expect(runStatus(all[0], [g])).toBe('needs_you')
    expect(gatesForRun([g], `ingest:${I}`)).toEqual([g])
  })
  it('status dots: needs you > failed > running > done', () => {
    expect(runStatus(fromRunRow(row(A, { status: 'failed' })), [])).toBe('failed')
    expect(runStatus(fromRunRow(row(A, { instantly_status: 'pushing' })), [])).toBe('running')
    expect(runStatus(fromRunRow(row(A)), [])).toBe('done')
  })
})

describe('?run / ?gate', () => {
  it('parses ?run= as a job id or ingest:<id>, ignoring anything else', () => {
    expect(parseRunParam(A.toUpperCase())).toBe(A)
    expect(parseRunParam(`ingest:${I}`)).toBe(`ingest:${I}`)
    expect(parseRunParam('nope')).toBeNull()
    expect(parseRunParam(null)).toBeNull()
  })
  it('an open gate link resolves to its run and step', () => {
    const gates = [gate('push_review', A)]
    expect(resolveGateLink(`push_review:${A}`, gates)).toEqual({ key: `push_review:${A}`, runId: A, step: 'review', state: 'open' })
  })
  it('a closed job gate still opens its run at that step; a closed ingest or a bad link opens nothing', () => {
    expect(resolveGateLink(`campaign_choice:${A}`, [])).toEqual({ key: null, runId: A, step: 'campaign', state: 'closed' })
    expect(resolveGateLink(`ingest_approval:${I}`, [])).toMatchObject({ runId: null, state: 'closed' })
    expect(resolveGateLink('garbage', [])).toMatchObject({ state: 'invalid', runId: null })
  })
  it('selection order: click, then ?run, then the gate link, then the default', () => {
    const runs = [fromRunRow(row(A))]
    const link = resolveGateLink(`push_review:${B}`, [gate('push_review', B)])
    expect(selectRun({ clicked: C, runParam: B, gate: link, runs, gates: [] })).toEqual({ runId: C, source: 'click' })
    expect(selectRun({ clicked: null, runParam: C, gate: link, runs, gates: [] })).toEqual({ runId: C, source: 'run' })
    expect(selectRun({ clicked: null, runParam: null, gate: link, runs, gates: [] })).toEqual({ runId: B, source: 'gate' })
    expect(selectRun({ clicked: null, runParam: null, gate: null, runs, gates: [] })).toEqual({ runId: A, source: 'default' })
  })
})

describe('the picker window', () => {
  const now = Date.parse('2026-11-09T00:00:00Z')
  const at = (id: string, created: string) => fromRunRow(row(id, { created_at: created, updated_at: created }))
  it('lists the last 4 months only, newest CSV first; a deep-linked older run is kept', () => {
    const jobs = [at(A, '2026-10-01T00:00:00Z'), at(B, '2026-11-08T00:00:00Z'), at(C, '2026-06-01T00:00:00Z')]
    expect(mergeRuns(jobs, [], [], now).map((r) => r.id)).toEqual([B, A])
    expect(mergeRuns(jobs, [], [at(C, '2026-06-01T00:00:00Z')], now).map((r) => r.id)).toEqual([B, A, C])
  })
})
