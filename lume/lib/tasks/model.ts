import { z } from 'zod'
import type { Json, LumeTaskRow, PendingActionStatus, TaskStatus } from '@/lib/db/types'
import { ownerDate, ownerTimeOfDay, ownerWallTime } from '@/lib/time/owner'

/**
 * Calendar tasks (`lume_tasks`), pure: status rules, Lume ↔ Linear mapping
 * and the request schemas. Storage is lib/tasks/store.ts, Linear sync
 * lib/tasks/sync.ts, due processing lib/tasks/tick.ts.
 *
 * A task is a reminder, or carries a requested pending action
 * (`action_kind` + `action_payload`, the `{ kind, payload }` POST
 * /api/actions takes). Scheduling spends nothing: when the task falls due the
 * tick builds that request fresh (`buildActionRequest`) and files it as an
 * AWAITING pending action, which the owner still taps. Nothing here runs.
 *
 * Ownership of fields between Lume and Linear: Linear wins for the due date
 * and for cancel; Lume wins for running / done of an action task (the action
 * decides those, not a Linear drag).
 */

/** All-day tasks are due at this wall-clock hour in the owner's zone. */
export const ALL_DAY_HOUR = 9

/** Statuses that still move (the tick and the Linear pull look at these). */
export const OPEN_STATUSES = ['scheduled', 'awaiting_tap', 'running'] as const satisfies readonly TaskStatus[]
export const isOpen = (s: TaskStatus): boolean => (OPEN_STATUSES as readonly string[]).includes(s)

export type LinearStateType = 'unstarted' | 'started' | 'completed' | 'canceled'

/** The Linear workflow-state type a task status shows as. */
export function linearStateFor(status: TaskStatus): LinearStateType {
  switch (status) {
    case 'scheduled':
      return 'unstarted'
    case 'awaiting_tap':
    case 'running':
      return 'started'
    case 'done':
      return 'completed'
    case 'failed':
    case 'cancelled':
      return 'canceled'
  }
}

/** Linear's `dueDate` (YYYY-MM-DD) for a task: its date in America/Los_Angeles. */
export const linearDueDate = (dueAt: string | Date): string => ownerDate(dueAt)

/**
 * A new due instant for a date moved in Linear: same wall-clock time of day
 * as before (all-day tasks: 09:00), on the new owner-zone date.
 */
export function dueAtOnDate(date: string, prevDueAt: string, allDay: boolean): string {
  const { hour, minute } = allDay ? { hour: ALL_DAY_HOUR, minute: 0 } : ownerTimeOfDay(prevDueAt)
  return ownerWallTime(date, hour, minute).toISOString()
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * A due value as the UI / agent send it: `YYYY-MM-DD` (all day, 09:00
 * Pacific) or an ISO datetime. A datetime without an offset is read as
 * owner-zone wall time. Null when it does not parse.
 */
export function parseDue(raw: string): { due_at: string; all_day: boolean } | null {
  const s = raw.trim()
  if (DATE_RE.test(s)) {
    const d = new Date(`${s}T00:00:00Z`)
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null
    return { due_at: ownerWallTime(s, ALL_DAY_HOUR).toISOString(), all_day: true }
  }
  if (!DATETIME_RE.test(s)) return null
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(s)
  if (hasZone) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : { due_at: d.toISOString(), all_day: false }
  }
  const [date, time] = s.split('T')
  const [h, m] = time.split(':').map(Number)
  if (h > 23 || m > 59) return null
  return { due_at: ownerWallTime(date, h, m).toISOString(), all_day: false }
}

/**
 * What a filed action's status means for its task. `awaiting` → still
 * awaiting_tap; null = no change (unknown status).
 */
export function statusFromAction(s: PendingActionStatus | string): TaskStatus | null {
  switch (s) {
    case 'awaiting':
      return 'awaiting_tap'
    case 'approved':
    case 'executing':
      return 'running'
    case 'executed':
      return 'done'
    case 'failed':
    case 'expired':
      return 'failed'
    case 'rejected':
      return 'cancelled'
    default:
      return null
  }
}

/** The fields of a linked Linear issue the pull reads. */
export interface LinearIssueState {
  id: string
  title: string
  dueDate: string | null
  stateType: string
  updatedAt: string
}

export type TaskPatch = Partial<Pick<LumeTaskRow, 'due_at' | 'status' | 'last_error' | 'reminded_at'>>

/**
 * What a Linear issue changes on its (open) task:
 *  - a different dueDate → due_at moves to that date (time of day kept);
 *    a cleared dueDate is ignored (Lume's tasks always have one);
 *  - canceled → cancelled (an awaiting action is left for the owner; noted);
 *  - completed → done, only for a task without an action (an action task is
 *    done when its action executed, never by a Linear drag).
 * Null when nothing changes.
 */
export function pullPatch(task: Pick<LumeTaskRow, 'due_at' | 'all_day' | 'status' | 'action_kind' | 'action_id'>, issue: LinearIssueState): TaskPatch | null {
  if (!isOpen(task.status)) return null
  const patch: TaskPatch = {}
  if (issue.dueDate && DATE_RE.test(issue.dueDate) && issue.dueDate !== linearDueDate(task.due_at)) {
    // A moved date re-arms a task that has not fired yet; one already filed keeps its action.
    patch.due_at = dueAtOnDate(issue.dueDate, task.due_at, task.all_day)
    if (task.status === 'scheduled') patch.reminded_at = null
  }
  if (issue.stateType === 'canceled') {
    patch.status = 'cancelled'
    if (task.action_id && task.status === 'awaiting_tap') {
      patch.last_error = 'Cancelled in Linear; the filed action still awaits a decision in Lume / Telegram.'
    }
  } else if (issue.stateType === 'completed' && !task.action_kind) {
    patch.status = 'done'
  }
  return Object.keys(patch).length ? patch : null
}

/** True when the task changed since its last push (or was never pushed). */
export function needsPush(task: Pick<LumeTaskRow, 'updated_at' | 'linear_synced_at'>): boolean {
  return !task.linear_synced_at || new Date(task.updated_at).getTime() > new Date(task.linear_synced_at).getTime()
}

// ---------------------------------------------------------------------------
// Request schemas (routes + agent tools)

/** A requested pending action: shape only here; `ActionRequestBody` + the builder check it fully. */
export const TaskAction = z.object({
  kind: z.string().regex(/^[a-z_]{3,40}$/),
  payload: z.record(z.string(), z.unknown()),
})

export const TaskCreateBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().max(4000).optional(),
    due: z.string().min(10).max(40),
    action: TaskAction.optional(),
    conversation_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).optional(),
  })
  .strict()
export type TaskCreate = z.infer<typeof TaskCreateBody>

/** Owner edits. Status may only be set to these by hand; the rest come from the action. */
export const MANUAL_STATUSES = ['scheduled', 'done', 'cancelled'] as const

export const TaskPatchBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().max(4000).nullable().optional(),
    due: z.string().min(10).max(40).optional(),
    status: z.enum(MANUAL_STATUSES).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'empty patch')
export type TaskPatchInput = z.infer<typeof TaskPatchBody>

/**
 * Whether a manual status change is allowed from `from`. Rescheduling (back
 * to scheduled) only from scheduled / failed / cancelled: a task whose action
 * is filed or running is decided by that action.
 */
export function manualTransitionOk(from: TaskStatus, to: (typeof MANUAL_STATUSES)[number]): boolean {
  if (to === 'scheduled') return from === 'scheduled' || from === 'failed' || from === 'cancelled'
  if (to === 'cancelled') return from !== 'done'
  return from !== 'cancelled' // done
}

/** The action request a task stores (Json-safe). */
export const actionRequestOf = (task: Pick<LumeTaskRow, 'action_kind' | 'action_payload'>): { kind: string; payload: Record<string, Json> } | null =>
  task.action_kind && task.action_payload ? { kind: task.action_kind, payload: task.action_payload } : null
