'use client'

import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { ArrowRight, Check, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { WaitChip } from '@/components/replies/WaitChip'
import { Surface } from '@/components/shell/Surface'
import { Scoreboard } from '@/components/today/Scoreboard'
import { fetchJson } from '@/hooks/fetcher'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import { patchDeal } from '@/lib/crm/client'
import { shortDate } from '@/lib/crm/pilot'
import { createTask, patchTask, taskErrorText } from '@/lib/tasks/client'
import type { TodayPayload } from '@/lib/today/types'
import { OWNER_TZ, ownerDate } from '@/lib/time/owner'
import { cn } from '@/lib/utils'

export const TODAY_KEY = '/api/today'

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: OWNER_TZ, hour: 'numeric', minute: '2-digit' })
const SECTION_WORDS: Record<string, string> = { scoreboard: 'the scoreboard', signals: 'signals', replies: 'replies', checkins: 'pilot check-ins', tasks: 'tasks' }

/**
 * `/today`: this week's scoreboard, then the queue of what needs doing now —
 * signal accounts not yet touched, positive replies waiting over an hour,
 * pilot check-ins due and the Calendar's tasks for today. Ticking a check-in
 * or a task is a note on Lume's own rows; nothing here sends or spends.
 *
 * One surface: the scoreboard and each queue are sections set apart by
 * space. The accent colour marks only what is late.
 */
export function TodayScreen({ initial }: { initial: TodayPayload }) {
  const { data = initial, mutate } = useSWR<TodayPayload>(TODAY_KEY, fetchJson, { fallbackData: initial, refreshInterval: 60_000, revalidateOnFocus: true })
  useRealtimeInvalidate(() => void mutate(), { tables: ['pending_actions', 'events'], throttleMs: 5_000 })
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  const [busy, setBusy] = useState<string | null>(null)
  const q = data.queue
  const total = q.signals.total + q.replies.items.length + q.checkins.length + q.tasks.length

  async function tickCheckin(dealId: string, day: 10 | 25) {
    setBusy(`checkin:${dealId}:${day}`)
    const a = await patchDeal(dealId, day === 10 ? { pilot_checkin_10_done: true } : { pilot_checkin_25_done: true })
    setBusy(null)
    if (a.status === 200) toast(`Day ${day} check-in done`)
    else toast.error('Could not save. Try again.')
    void mutate()
  }

  async function finishTask(id: string) {
    setBusy(`task:${id}`)
    const a = await patchTask(id, { status: 'done' })
    setBusy(null)
    if (a.status === 200) toast('Task done')
    else toast.error(taskErrorText(a))
    void mutate()
  }

  return (
    <Surface className="max-w-[880px]">
      {data.scoreboard ? <Scoreboard board={data.scoreboard} editable onSaved={() => void mutate()} /> : <p className="text-[13px] text-fg-46">The scoreboard could not load. Refresh to try again.</p>}

      <section aria-label="Do now" className="flex flex-col gap-10">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-[15px] font-medium text-fg">Do now</h2>
          <span className="font-mono text-[12px] text-fg-46">{total === 0 ? 'clear' : `${total} waiting`}</span>
        </div>
        {data.errors.length > 0 && (
          <p role="status" className="text-[13px] text-fg-70">
            Could not load {data.errors.map((e) => SECTION_WORDS[e] ?? e).join(', ')}. The rest is current.
          </p>
        )}

        <Group title="Replies waiting over an hour" count={q.replies.items.length} href="/replies" linkLabel={q.replies.open > 0 ? `All ${q.replies.open} open` : 'Replies'} empty={q.replies.open > 0 ? `${q.replies.open} open, none past the hour.` : 'No positive replies waiting.'}>
          {q.replies.items.map((r) => (
            <Row key={r.reply_to_uuid} title={r.lead_name ?? r.lead_email} detail={[r.company, r.untrusted_excerpt ? `“${r.untrusted_excerpt}”` : null].filter(Boolean).join(' · ')} right={<WaitChip since={r.received_at} now={now} />}>
              <Link href="/replies" className="text-[13px] text-fg-70 hover:text-fg">
                Open
              </Link>
            </Row>
          ))}
        </Group>

        <Group title="Pilot check-ins due" count={q.checkins.length} href="/crm" linkLabel="Pipeline" empty="No check-ins due.">
          {q.checkins.map((c) => (
            <Row
              key={`${c.deal_id}:${c.day}`}
              title={`${c.company ?? c.name ?? c.email} — day ${c.day}`}
              detail={`${c.name && c.company ? `${c.name} · ` : ''}due ${shortDate(c.due_date)}${c.days_late > 0 ? ` · ${c.days_late} d late` : ' · today'}`}
              late={c.days_late > 0}
            >
              <Link href={`/crm?campaign=${encodeURIComponent(c.campaign_id)}&deal=${c.deal_id}`} className="text-[13px] text-fg-70 hover:text-fg">
                Open deal
              </Link>
              <Button size="sm" variant="secondary" className="rounded-lg" disabled={busy !== null} onClick={() => void tickCheckin(c.deal_id, c.day)}>
                <Check /> Done
              </Button>
            </Row>
          ))}
        </Group>

        <Group title="Signal accounts not yet touched" count={q.signals.total} href="/signals" linkLabel={q.signals.total > q.signals.items.length ? `All ${q.signals.total}` : 'Signals'} empty="Every signal account has been touched.">
          {q.signals.items.map((s) => (
            <Row key={s.key} title={s.company} detail={[s.untrusted_detail, s.at ? shortDate(ownerDate(s.at)) : null].filter(Boolean).join(' · ')} right={<span className="text-[12px] text-fg-46">{s.sources.join(' · ')}</span>}>
              <Link href={s.href} aria-label={`Open ${s.company}`} className="grid size-8 place-items-center rounded-lg text-fg-70 hover:bg-secondary hover:text-fg">
                <ArrowRight className="size-4" strokeWidth={1.75} aria-hidden />
              </Link>
            </Row>
          ))}
        </Group>

        <Group title="Tasks" count={q.tasks.length} href="/calendar" linkLabel="Calendar" empty="Nothing due today.">
          {q.tasks.map((t) => (
            <Row
              key={t.id}
              title={t.title}
              detail={t.overdue ? `overdue since ${shortDate(ownerDate(t.due_at))}` : t.all_day ? 'today' : `today ${timeFmt.format(new Date(t.due_at))}`}
              late={t.overdue}
            >
              {t.action_id ? (
                <Link href={`/actions/${t.action_id}`} className="text-[13px] text-fg hover:underline">
                  Waiting for Confirm
                </Link>
              ) : (
                <Button size="sm" variant="secondary" className="rounded-lg" disabled={busy !== null} onClick={() => void finishTask(t.id)}>
                  <Check /> Done
                </Button>
              )}
            </Row>
          ))}
          <AddTask today={data.today} onAdded={() => void mutate()} />
        </Group>
      </section>
    </Surface>
  )
}

/** One queue: a heading line and its rows. No card of its own and no rules between rows; space does the separating. */
function Group({ title, count, href, linkLabel, empty, children }: { title: string; count: number; href: string; linkLabel: string; empty: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <header className="flex items-baseline gap-3">
        <h3 className={cn('text-[13px] font-medium', count > 0 ? 'text-fg' : 'text-fg-46')}>{title}</h3>
        <span data-count className="font-mono text-[12px] text-fg-46 tabular-nums">
          {count}
        </span>
        <Link href={href} className="ml-auto text-[12px] text-fg-46 hover:text-fg">
          {linkLabel}
        </Link>
      </header>
      {count === 0 && <p className="text-[13px] text-fg-46">{empty}</p>}
      <ul className="flex flex-col gap-4">{children}</ul>
    </section>
  )
}

function Row({ title, detail, right, late, children }: { title: string; detail?: string; right?: ReactNode; late?: boolean; children?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex items-center gap-2 text-[14px] text-fg">
          {late && <span aria-hidden data-late className="size-1.5 shrink-0 rounded-full bg-primary" />}
          <span className="truncate">{title}</span>
        </p>
        {detail && <p className="line-clamp-1 text-[13px] text-fg-46">{detail}</p>}
      </div>
      {right}
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </li>
  )
}

/** A reminder for today (all day): the same `POST /api/tasks` the Calendar uses. Scheduling runs nothing. */
function AddTask({ today, onAdded }: { today: string; onAdded: () => void }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <li>
      <form
        className="flex items-center gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          const t = title.trim()
          if (!t || busy) return
          setBusy(true)
          const a = await createTask({ title: t, due: today })
          setBusy(false)
          if (a.status === 200 || a.status === 201) {
            setTitle('')
            onAdded()
          } else toast.error(taskErrorText(a))
        }}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder="Add a task for today"
          aria-label="Add a task for today"
          className="h-8 min-w-0 flex-1 rounded-lg bg-secondary px-3 text-[14px] text-fg outline-none placeholder:text-fg-46 focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button size="sm" variant="secondary" className="rounded-lg" type="submit" disabled={busy || !title.trim()}>
          <Plus /> Add
        </Button>
      </form>
    </li>
  )
}
