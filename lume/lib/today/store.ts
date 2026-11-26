import 'server-only'
import { checkinsDue } from '@/lib/crm/pilot'
import { getPilotDeals } from '@/lib/crm/service'
import { listHiringRows } from '@/lib/hiring/store'
import { waitingOf } from '@/lib/replies/waiting'
import { loadWaitingReplies } from '@/lib/replies/store'
import { getScoreboard } from '@/lib/scoreboard/store'
import { addDays } from '@/lib/crm/pilot'
import { listOpenTasksDue } from '@/lib/tasks/store'
import { ownerDate, ownerDayStart } from '@/lib/time/owner'
import type { TodayCheckin, TodayPayload, TodaySignal, TodayTask } from '@/lib/today/types'

const SIGNALS_SHOWN = 8

const SIGNAL_WORD: Record<string, string> = { hiring: 'Hiring', new_manager: 'New manager', expansion: 'Expansion' }

/** Signal accounts not yet touched. Until the Signals inbox exists this is the Hiring Ops sheet's new rows. */
async function untouchedSignals(): Promise<{ items: TodaySignal[]; total: number }> {
  const { rows, total } = await listHiringRows({ status: 'new', signal: 'all', tier: 'all', skipped: false, offset: 0, limit: SIGNALS_SHOWN })
  return {
    total,
    items: rows.map((r) => ({
      key: `hiring:${r.id}`,
      company: r.company_name ?? r.company_domain ?? 'Unknown company',
      untrusted_detail: [SIGNAL_WORD[r.signal] ?? r.signal, r.role_title ?? r.headline].filter(Boolean).join(': ') || null,
      sources: ['Hiring'],
      at: r.posted_at ?? r.created_at,
      href: '/signals/hiring',
    })),
  }
}

/**
 * Everything /today shows, read only. Each section loads on its own: one
 * failing read is named in `errors` and the rest still render.
 */
export async function loadToday(now: Date = new Date()): Promise<TodayPayload> {
  const today = ownerDate(now)
  const errors: string[] = []
  const safe = async <T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run()
    } catch (err) {
      console.error(`[today] ${name} failed:`, err instanceof Error ? err.message : err)
      errors.push(name)
      return fallback
    }
  }
  const [scoreboard, signals, replies, pilots, tasks] = await Promise.all([
    safe('scoreboard', () => getScoreboard(now), null),
    safe('signals', untouchedSignals, { items: [], total: 0 }),
    safe('replies', () => loadWaitingReplies(), []),
    safe('checkins', () => getPilotDeals(), []),
    safe('tasks', () => listOpenTasksDue(ownerDayStart(addDays(today, 1)).toISOString()), []),
  ])
  const checkins: TodayCheckin[] = checkinsDue(pilots, today).map((c) => ({
    deal_id: c.deal.id,
    campaign_id: c.deal.campaign_id,
    name: c.deal.name,
    company: c.deal.company,
    email: c.deal.email,
    day: c.day,
    due_date: c.due_date,
    days_late: c.days_late,
  }))
  const overdue = replies.filter((r) => waitingOf(r.received_at, now).overdue).sort((a, b) => a.received_at.localeCompare(b.received_at))
  const todayTasks: TodayTask[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    due_at: t.due_at,
    all_day: t.all_day,
    status: t.status,
    action_id: t.action_id,
    linear_url: t.linear_url,
    overdue: ownerDate(t.due_at) < today,
  }))
  return { today, scoreboard, queue: { signals, replies: { items: overdue, open: replies.length }, checkins, tasks: todayTasks }, errors }
}
