import { describe, expect, it } from 'vitest'
import { GATE_KINDS, type GateRow } from '@/lib/db/types'
import { LUME_ALLOWED_ACTIONS } from '@/lib/adapters/pipeline.actions'
import { buttonsFor, BUTTON_SPECS, hotkeyTarget, KIND_LABEL, LFO_PRESETS } from '@/lib/validate/actions'

const gate = (kind: GateRow['kind'], actions?: string[]): GateRow => ({
  kind,
  target_table: 'validation_jobs',
  target_id: '11111111-1111-4111-8111-111111111111',
  title: 't',
  subtitle: null,
  actions: actions ?? [],
  counts: {},
  telegram_message_id: null,
  created_at: '2026-10-15T00:00:00Z',
})

describe('BUTTON_SPECS', () => {
  it.each(GATE_KINDS)('%s has at least one button and a label', (kind) => {
    expect(BUTTON_SPECS[kind].length).toBeGreaterThan(0)
    expect(KIND_LABEL[kind]).toBeTruthy()
  })

  it('every decide button is on the entrypoint allowlist; push_go/camp_launch never are decide buttons', () => {
    const allowed = new Set<string>(LUME_ALLOWED_ACTIONS)
    for (const kind of GATE_KINDS) {
      for (const s of BUTTON_SPECS[kind]) {
        if (s.mode === 'decide') {
          expect(allowed.has(s.action), `${kind}:${s.action}`).toBe(true)
          expect(['push_go', 'camp_launch', 'lume_ok', 'lume_no']).not.toContain(s.action)
        }
      }
    }
  })

  it('push_review "Push these" creates a pending action instead of sending push_go', () => {
    const push = BUTTON_SPECS.push_review.find((s) => s.label === 'Push these')
    expect(push).toMatchObject({ mode: 'create_action', actionKind: 'push_to_instantly', tone: 'approve' })
    expect(BUTTON_SPECS.push_review.find((s) => s.action === 'push_cancel')).toMatchObject({ mode: 'decide', tone: 'reject' })
  })

  it('lume_action buttons go to the action decide endpoint', () => {
    expect(BUTTON_SPECS.lume_action.map((s) => [s.action, s.mode, s.tone])).toEqual([
      ['lume_ok', 'action_decide', 'approve'],
      ['lume_no', 'action_decide', 'reject'],
    ])
  })

  it('lfo_count offers the presets and a custom count', () => {
    const counts = BUTTON_SPECS.lfo_count.filter((s) => s.count !== undefined).map((s) => s.count)
    expect(counts).toEqual([...LFO_PRESETS])
    expect(BUTTON_SPECS.lfo_count.some((s) => s.needsCount)).toBe(true)
  })

  it('reject-like buttons: deny, skip, abort, discard, cancel', () => {
    const rejects = GATE_KINDS.flatMap((k) => BUTTON_SPECS[k].filter((s) => s.tone === 'reject').map((s) => s.action))
    expect(new Set(rejects)).toEqual(
      new Set(['deny', 'push_cancel', 'jobs_skip', 'jobs_abort', 'jobs_discard', 'lfo_cancel', 'lume_no'])
    )
  })
})

describe('buttonsFor', () => {
  it('ingest_approval narrows to the actions the view offers (deny only without an email column)', () => {
    expect(buttonsFor(gate('ingest_approval', ['deny'])).map((s) => s.action)).toEqual(['deny'])
    expect(buttonsFor(gate('ingest_approval', ['approve', 'approve_enrich', 'deny'])).map((s) => s.action)).toEqual([
      'approve',
      'approve_enrich',
      'deny',
    ])
  })
  it('other kinds use the full spec list', () => {
    expect(buttonsFor(gate('jobs_review', ['jobs_pull', 'jobs_skip'])).map((s) => s.action)).toEqual(['jobs_pull', 'jobs_skip'])
  })
})

describe('hotkeyTarget', () => {
  it('approve = first keyboard-safe approve-like button', () => {
    expect(hotkeyTarget(BUTTON_SPECS.ingest_approval, 'approve')?.action).toBe('approve')
    expect(hotkeyTarget(BUTTON_SPECS.jobs_review, 'approve')?.action).toBe('jobs_pull')
    expect(hotkeyTarget(BUTTON_SPECS.push_review, 'approve')?.mode).toBe('create_action')
    expect(hotkeyTarget(BUTTON_SPECS.campaign_choice, 'approve')?.mode).toBe('panel')
  })
  it('reject = first reject-like button', () => {
    expect(hotkeyTarget(BUTTON_SPECS.ingest_approval, 'reject')?.action).toBe('deny')
    expect(hotkeyTarget(BUTTON_SPECS.jobs_stall, 'reject')?.action).toBe('jobs_abort')
    expect(hotkeyTarget(BUTTON_SPECS.stall, 'reject')).toBeUndefined()
  })
  it('spending actions are click-only', () => {
    expect(hotkeyTarget(BUTTON_SPECS.jobs_fill, 'approve')).toBeUndefined()
    expect(hotkeyTarget(BUTTON_SPECS.finder_decision, 'approve')).toBeUndefined()
    expect(hotkeyTarget(BUTTON_SPECS.lfo_count, 'approve')).toBeUndefined()
    // approve_enrich is never reached by A (plain approve comes first, and it is excluded anyway).
    expect(hotkeyTarget(BUTTON_SPECS.ingest_approval.filter((s) => s.action !== 'approve'), 'approve')).toBeUndefined()
  })
  it('pending-action Confirm/Cancel are click-only', () => {
    expect(hotkeyTarget(BUTTON_SPECS.lume_action, 'approve')).toBeUndefined()
    expect(hotkeyTarget(BUTTON_SPECS.lume_action, 'reject')).toBeUndefined()
  })
})

import { validationRelevant } from '@/hooks/useValidationQueue'

describe('validationRelevant', () => {
  const ev = (type: string) => ({ table: 'events' as const, eventType: 'INSERT' as const, record: { type } })
  it('refetches on pipeline status events and lume.* events', () => {
    for (const t of ['validation_jobs.instantly_status', 'telegram_ingests.inserted', 'job_batches.status', 'apollo_orders.count_status', 'lume.decision']) {
      expect(validationRelevant(ev(t)), t).toBe(true)
    }
  })
  it('ignores replies, rotation and agent events', () => {
    for (const t of ['reply', 'rotation_runs.status', 'agent.tool', 'lead_bank.state']) expect(validationRelevant(ev(t)), t).toBe(false)
  })
  it('every pending_actions change counts', () => {
    expect(validationRelevant({ table: 'pending_actions', eventType: 'UPDATE', record: {} })).toBe(true)
  })
  it('row edits and barrier changes do not refetch the queue', () => {
    expect(validationRelevant(ev('lume.row_edit'))).toBe(false)
    expect(validationRelevant(ev('lume.barriers'))).toBe(false)
  })
})

import { countChips, groupByKind } from '@/lib/validate/actions'
import { formatEta } from '@/lib/validate/client'

describe('groupByKind', () => {
  it('groups in pipeline order and keeps gate order inside a group', () => {
    const a = { ...gate('jobs_review'), target_id: 'a' }
    const b = { ...gate('campaign_choice'), target_id: 'b' }
    const c = { ...gate('jobs_review'), target_id: 'c' }
    const groups = groupByKind([a, b, c])
    expect(groups.map((g) => [g.kind, g.gates.map((x) => x.target_id)])).toEqual([
      ['campaign_choice', ['b']],
      ['jobs_review', ['a', 'c']],
    ])
  })
})

describe('countChips', () => {
  it('shows known numeric counts only', () => {
    expect(countChips({ valid_count: 24, candidates: null, enrich: true, apollo_url: 'x' })).toEqual([{ label: 'valid', value: 24 }])
  })
})

describe('formatEta', () => {
  it('formats', () => {
    expect(formatEta(null)).toBeNull()
    expect(formatEta(0)).toBeNull()
    expect(formatEta(45)).toBe('~45 s')
    expect(formatEta(240)).toBe('~4 min')
    expect(formatEta(4800)).toBe('~1 h 20 min')
  })
})
