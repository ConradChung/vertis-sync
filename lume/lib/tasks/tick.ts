import 'server-only'
import { buildActionRequest } from '@/lib/actions/build'
import { createAction, DuplicateActionError, InvalidActionPayloadError } from '@/lib/actions/create'
import { getActionStatuses } from '@/lib/actions/store'
import { sendMessage } from '@/lib/adapters/telegram'
import { alert, alertLink, titleFrom } from '@/lib/alerts'
import type { LumeTaskRow } from '@/lib/db/types'
import { actionRequestOf, needsPush, statusFromAction } from '@/lib/tasks/model'
import { claimDueTask, claimReminder, getDueTasks, getPushCandidates, getTasksWithOpenActions, updateTask } from '@/lib/tasks/store'
import { pullLinear, pushTask } from '@/lib/tasks/sync'

/**
 * Calendar tasks on the rotation tick (pg_cron, every 15 min), after the
 * rules. Notify-only, like the rest of the tick:
 *
 *  1. Due action tasks: claimed scheduled → awaiting_tap (one conditional
 *     UPDATE, so concurrent ticks never file twice), then the stored request
 *     is built fresh (`buildActionRequest`, the same builder as a Lume click)
 *     and filed with `createAction` as an AWAITING pending action — the
 *     owner's tap in Telegram / Lume still decides it. A refused build or an
 *     invalid payload fails the task (`last_error`); an identical action
 *     already awaiting is linked instead.
 *     Due plain tasks (reminders): one Telegram / feed reminder
 *     (`reminded_at` claim); the status stays scheduled until the owner marks
 *     it done in Lume or Linear.
 *  2. Reconcile: a filed action's status moves its task (approved /
 *     executing → running, executed → done, failed / expired → failed,
 *     rejected → cancelled).
 *  3. Pull Linear (date, cancel, done for plain tasks), then push tasks
 *     changed since their last sync.
 *
 * Each step is capped and failure-isolated; `runTaskTick` never throws.
 */

export const DUE_LIMIT = 25
export const RECONCILE_LIMIT = 50
export const PUSH_LIMIT = 10
const PUSH_WINDOW_MS = 7 * 24 * 3600_000

export type DueOutcome =
  | { task_id: string; outcome: 'filed'; action_id: string }
  | { task_id: string; outcome: 'linked_existing'; action_id: string }
  | { task_id: string; outcome: 'reminded' }
  | { task_id: string; outcome: 'skipped'; reason: 'claimed_elsewhere' }
  | { task_id: string; outcome: 'failed'; error: string }

export interface TaskTickResult {
  due: DueOutcome[]
  reconciled: { task_id: string; status: string }[]
  pulled: number
  pushed: number
  errors: string[]
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

export async function runTaskTick(now: Date): Promise<TaskTickResult> {
  const out: TaskTickResult = { due: [], reconciled: [], pulled: 0, pushed: 0, errors: [] }
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      out.errors.push(`${name}: ${msg(err)}`)
      console.error(`[task-tick] ${name} failed:`, msg(err))
    }
  }

  await step('due', async () => {
    for (const task of await getDueTasks(now.toISOString(), DUE_LIMIT)) out.due.push(await runDue(task, now))
  })
  await step('reconcile', async () => {
    out.reconciled = await reconcile()
  })
  await step('pull', async () => {
    const r = await pullLinear(now)
    out.pulled = r.changed.length
    if (r.error) out.errors.push(`pull: ${r.error}`)
  })
  await step('push', async () => {
    const since = new Date(now.getTime() - PUSH_WINDOW_MS).toISOString()
    const todo = (await getPushCandidates(since, 100)).filter(needsPush).slice(0, PUSH_LIMIT)
    for (const t of todo) if ((await pushTask(t)).ok) out.pushed++
  })
  return out
}

async function notify(task: LumeTaskRow, text: string, severity: 'info' | 'warn') {
  await alert({
    source: 'lume.calendar', severity, title: titleFrom(text), body: text,
    link: alertLink(`/calendar?task=${task.id}`),
    telegram: () => sendMessage(text, { disablePreview: true }).catch(() => null),
  }).catch(() => null)
}

async function runDue(task: LumeTaskRow, now: Date): Promise<DueOutcome> {
  const nowIso = now.toISOString()
  const request = actionRequestOf(task)

  if (!request) {
    if (!(await claimReminder(task.id, nowIso))) return { task_id: task.id, outcome: 'skipped', reason: 'claimed_elsewhere' }
    await notify(task, `📅 Due: ${task.title}${task.notes ? `\n${task.notes.slice(0, 500)}` : ''}\nMark it done in Lume (Calendar) or Linear.`, 'info')
    return { task_id: task.id, outcome: 'reminded' }
  }

  if (!(await claimDueTask(task.id, nowIso))) return { task_id: task.id, outcome: 'skipped', reason: 'claimed_elsewhere' }

  const fail = async (error: string): Promise<DueOutcome> => {
    await updateTask(task.id, { status: 'failed', last_error: error.slice(0, 1000) }).catch(() => null)
    await notify(task, `⚠️ Scheduled task "${task.title}" could not file its ${request.kind} action: ${error}\nNothing ran.`, 'warn')
    return { task_id: task.id, outcome: 'failed', error }
  }

  try {
    const built = await buildActionRequest(request)
    if (!built.ok) return await fail(`${built.error}${built.problems?.length ? `: ${built.problems.slice(0, 3).join('; ')}` : ''}`)
    const action = await createAction(built.kind, built.payload, task.created_by === 'agent' ? 'agent' : 'user', { ruleId: built.ruleId ?? null })
    await updateTask(task.id, { action_id: action.id, last_error: null })
    // createAction already sent the approval prompt (lume_ok / lume_no); this says where it came from.
    await notify(task, `📅 Scheduled task due: ${task.title}\nFiled ${built.kind} for your approval — tap Approve on the prompt or in Lume. Nothing runs until you do.`, 'info')
    return { task_id: task.id, outcome: 'filed', action_id: action.id }
  } catch (err) {
    if (err instanceof DuplicateActionError) {
      if (!err.existingId) return await fail('an identical action is already awaiting approval')
      await updateTask(task.id, { action_id: err.existingId, last_error: 'An identical action was already awaiting approval; linked to it.' })
      return { task_id: task.id, outcome: 'linked_existing', action_id: err.existingId }
    }
    if (err instanceof InvalidActionPayloadError) return await fail(`invalid payload: ${err.message}`)
    return await fail(msg(err))
  }
}

async function reconcile(): Promise<TaskTickResult['reconciled']> {
  const tasks = await getTasksWithOpenActions(RECONCILE_LIMIT)
  if (!tasks.length) return []
  const statuses = await getActionStatuses(tasks.map((t) => t.action_id!))
  const out: TaskTickResult['reconciled'] = []
  for (const t of tasks) {
    const actionStatus = statuses.get(t.action_id!)
    // A deleted action (FK set null never reaches here; a missing row is a stale read): leave it.
    if (!actionStatus) continue
    const next = statusFromAction(actionStatus)
    if (!next || next === t.status) continue
    const updated = await updateTask(t.id, { status: next, ...(next === 'failed' ? { last_error: `action ${actionStatus}` } : {}) }, ['awaiting_tap', 'running'])
    if (updated) out.push({ task_id: t.id, status: next })
  }
  return out
}
