import { describe, expect, it } from 'vitest'
import { dueAtOnDate, linearDueDate, linearStateFor, manualTransitionOk, needsPush, parseDue, pullPatch, statusFromAction } from '@/lib/tasks/model'

const task = (over: Record<string, unknown> = {}) => ({
  due_at: '2026-11-20T17:00:00.000Z', // 09:00 PST
  all_day: true,
  status: 'scheduled' as const,
  action_kind: null,
  action_id: null,
  ...over,
})
const issue = (over: Record<string, unknown> = {}) => ({ id: 'i1', title: 't', dueDate: '2026-11-20', stateType: 'unstarted', updatedAt: '2026-11-10T00:00:00Z', ...over })

describe('status → Linear state', () => {
  it('maps every status', () => {
    expect(linearStateFor('scheduled')).toBe('unstarted')
    expect(linearStateFor('awaiting_tap')).toBe('started')
    expect(linearStateFor('running')).toBe('started')
    expect(linearStateFor('done')).toBe('completed')
    expect(linearStateFor('failed')).toBe('canceled')
    expect(linearStateFor('cancelled')).toBe('canceled')
  })
})

describe('due dates in America/Los_Angeles', () => {
  it('Linear dueDate is the Pacific date, not the UTC one', () => {
    // 2026-11-21 04:30 UTC is still the 20th in LA (20:30 PST).
    expect(linearDueDate('2026-11-21T04:30:00Z')).toBe('2026-11-20')
    expect(linearDueDate('2026-07-01T06:59:00Z')).toBe('2026-06-30') // PDT
  })

  it('a date alone is all day at 09:00 Pacific, across DST', () => {
    expect(parseDue('2026-11-20')).toEqual({ due_at: '2026-11-20T17:00:00.000Z', all_day: true })
    expect(parseDue('2026-07-01')).toEqual({ due_at: '2026-07-01T16:00:00.000Z', all_day: true })
  })

  it('a datetime without offset is Pacific wall time; with offset it is taken as is', () => {
    expect(parseDue('2026-11-20T14:30')).toEqual({ due_at: '2026-11-20T22:30:00.000Z', all_day: false })
    expect(parseDue('2026-11-20T14:30:00Z')).toEqual({ due_at: '2026-11-20T14:30:00.000Z', all_day: false })
  })

  it('refuses junk', () => {
    expect(parseDue('2026-02-30')).toBeNull()
    expect(parseDue('tomorrow')).toBeNull()
    expect(parseDue('2026-11-20T25:00')).toBeNull()
  })

  it('moving a date keeps the time of day (all day → 09:00)', () => {
    expect(dueAtOnDate('2026-11-25', '2026-11-20T22:30:00.000Z', false)).toBe('2026-11-25T22:30:00.000Z')
    // Across the DST change the wall time stays 14:30.
    expect(dueAtOnDate('2026-10-30', '2026-11-20T22:30:00.000Z', false)).toBe('2026-10-30T21:30:00.000Z')
    expect(dueAtOnDate('2026-11-25', '2026-11-20T22:30:00.000Z', true)).toBe('2026-11-25T17:00:00.000Z')
  })
})

describe('reconcile: action status → task status', () => {
  it('maps the pending_action lifecycle', () => {
    expect(statusFromAction('awaiting')).toBe('awaiting_tap')
    expect(statusFromAction('approved')).toBe('running')
    expect(statusFromAction('executing')).toBe('running')
    expect(statusFromAction('executed')).toBe('done')
    expect(statusFromAction('failed')).toBe('failed')
    expect(statusFromAction('expired')).toBe('failed')
    expect(statusFromAction('rejected')).toBe('cancelled')
    expect(statusFromAction('weird')).toBeNull()
  })
})

describe('pull from Linear', () => {
  it('no change → null', () => {
    expect(pullPatch(task(), issue())).toBeNull()
  })

  it('a moved date moves due_at and re-arms the reminder', () => {
    expect(pullPatch(task(), issue({ dueDate: '2026-11-24' }))).toEqual({ due_at: '2026-11-24T17:00:00.000Z', reminded_at: null })
  })

  it('canceled in Linear cancels; an awaiting action is left and noted', () => {
    expect(pullPatch(task(), issue({ stateType: 'canceled' }))).toEqual({ status: 'cancelled' })
    const p = pullPatch(task({ status: 'awaiting_tap', action_kind: 'run_actor', action_id: 'a1' }), issue({ stateType: 'canceled' }))
    expect(p?.status).toBe('cancelled')
    expect(p?.last_error).toMatch(/still awaits/)
  })

  it('completed in Linear finishes a plain task, never an action task', () => {
    expect(pullPatch(task(), issue({ stateType: 'completed' }))).toEqual({ status: 'done' })
    expect(pullPatch(task({ action_kind: 'run_actor', status: 'awaiting_tap', action_id: 'a1' }), issue({ stateType: 'completed' }))).toBeNull()
  })

  it('closed tasks are not touched', () => {
    expect(pullPatch(task({ status: 'done' }), issue({ stateType: 'canceled', dueDate: '2026-12-01' }))).toBeNull()
  })
})

describe('push + manual transitions', () => {
  it('needsPush when never synced or edited since', () => {
    expect(needsPush({ updated_at: '2026-11-10T00:00:00Z', linear_synced_at: null })).toBe(true)
    expect(needsPush({ updated_at: '2026-11-10T00:00:01Z', linear_synced_at: '2026-11-10T00:00:00Z' })).toBe(true)
    expect(needsPush({ updated_at: '2026-11-10T00:00:00Z', linear_synced_at: '2026-11-10T00:00:00Z' })).toBe(false)
  })

  it('reschedule only from scheduled / failed / cancelled', () => {
    expect(manualTransitionOk('failed', 'scheduled')).toBe(true)
    expect(manualTransitionOk('awaiting_tap', 'scheduled')).toBe(false)
    expect(manualTransitionOk('done', 'cancelled')).toBe(false)
    expect(manualTransitionOk('cancelled', 'done')).toBe(false)
  })
})
