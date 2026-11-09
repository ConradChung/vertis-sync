'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import useSWR from 'swr'
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { GlassCard } from '@/components/ui/glass-card'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { TagChip } from '@/components/tags/TagChip'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { fetchJson } from '@/hooks/fetcher'
import { PHONE_QUERY, useMediaQuery } from '@/hooks/useMediaQuery'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import type { LumeTaskRow } from '@/lib/db/types'
import { addMonths, dayLabel, groupByDay, monthGrid, monthLabel, ownerToday, tasksKeyForMonth } from '@/lib/tasks/calendar'
import { cancelTask, createTask, dueOf, patchTask, STATUS_LABEL, STATUS_TONE, taskErrorText, type TasksPayload } from '@/lib/tasks/client'
import { OWNER_TZ, ownerDate } from '@/lib/time/owner'
import { cn } from '@/lib/utils'

/**
 * `/calendar`: scheduled tasks by month (Mon-first grid) or as an agenda list
 * (the default on phones), mirrored to Linear's "Lume" project. A day opens
 * the create dialog; a task opens its detail sheet (`?task=<id>` deep-links
 * to it). A task with an action is filed for a tap when it falls due — the
 * calendar never runs anything.
 */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MAX_CHIPS = 3

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: OWNER_TZ, hour: 'numeric', minute: '2-digit' })
const timeInputFmt = new Intl.DateTimeFormat('en-GB', { timeZone: OWNER_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const dueText = (t: LumeTaskRow) => `${dayLabel(ownerDate(t.due_at))}${t.all_day ? ' · all day' : ` · ${timeFmt.format(new Date(t.due_at))} PT`}`

export function CalendarScreen() {
  const today = ownerToday()
  const [cursor, setCursor] = useState(() => `${today.slice(0, 7)}-01`)
  const phone = useMediaQuery(PHONE_QUERY)
  const [view, setView] = useState<'month' | 'agenda' | null>(null)
  const shown = view ?? (phone ? 'agenda' : 'month')

  const key = tasksKeyForMonth(cursor)
  const swr = useSWR<TasksPayload>(key, fetchJson, { refreshInterval: 60_000, keepPreviousData: true })
  useRealtimeInvalidate(() => void swr.mutate(), { tables: ['pending_actions'] })
  const tasks = useMemo(() => swr.data?.tasks ?? [], [swr.data])
  const byDay = useMemo(() => groupByDay(tasks), [tasks])

  // ?task=<id>: the detail sheet, from this month's list or fetched on its own.
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const openId = params.get('task')
  const listed = openId ? tasks.find((t) => t.id === openId) : undefined
  const single = useSWR<{ task: LumeTaskRow }>(openId && !listed ? `/api/tasks/${openId}` : null, fetchJson)
  const openTask = listed ?? single.data?.task ?? null
  const setOpen = (id: string | null) => {
    const q = new URLSearchParams(params.toString())
    if (id) q.set('task', id)
    else q.delete('task')
    router.replace(`${pathname}${q.toString() ? `?${q}` : ''}`, { scroll: false })
  }
  // A deep link to another month moves the grid there.
  useEffect(() => {
    if (single.data?.task) setCursor(`${ownerDate(single.data.task.due_at).slice(0, 7)}-01`)
  }, [single.data])

  const [creating, setCreating] = useState<string | null>(null)
  const refresh = () => void swr.mutate()

  return (
    <div className="flex flex-col gap-4">
      <LinearBanner linear={swr.data?.linear} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" aria-label="Previous month" onClick={() => setCursor(addMonths(cursor, -1))}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCursor(`${today.slice(0, 7)}-01`)}>
            Today
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="Next month" onClick={() => setCursor(addMonths(cursor, 1))}>
            <ChevronRight />
          </Button>
        </div>
        <h2 className="min-w-0 flex-1 text-[15px] font-semibold text-fg" aria-live="polite">
          {monthLabel(cursor)}
        </h2>
        <ToggleGroup value={[shown]} onValueChange={(v: string[]) => v[0] && setView(v[0] as 'month' | 'agenda')} aria-label="View">
          <ToggleGroupItem value="month" size="sm">Month</ToggleGroupItem>
          <ToggleGroupItem value="agenda" size="sm">Agenda</ToggleGroupItem>
        </ToggleGroup>
        <Button size="sm" onClick={() => setCreating(today)}>
          <Plus aria-hidden /> New task
        </Button>
      </div>

      {swr.error && !swr.data ? (
        <p role="alert" className="text-[13px] text-red">Could not load tasks ({swr.error.message}).</p>
      ) : shown === 'month' ? (
        <MonthGrid cursor={cursor} today={today} byDay={byDay} loading={!swr.data} onDay={setCreating} onTask={setOpen} />
      ) : (
        <Agenda cursor={cursor} today={today} byDay={byDay} loading={!swr.data} onDay={setCreating} onTask={setOpen} />
      )}

      <CreateDialog date={creating} onClose={() => setCreating(null)} onSaved={refresh} />
      <TaskSheet task={openTask} open={!!openId} onOpenChange={(o) => !o && setOpen(null)} onSaved={refresh} />
    </div>
  )
}

function LinearBanner({ linear }: { linear?: TasksPayload['linear'] }) {
  if (!linear) return null
  const text = !linear.configured
    ? "Linear isn't connected (LINEAR_API_KEY), so tasks stay in Lume only."
    : linear.error
      ? `Last Linear sync failed: ${linear.error.error}. It retries on the next tick.`
      : null
  if (!text) return null
  return (
    <p role="status" className="flex items-start gap-2 rounded-panel border border-amber/30 bg-amber/10 px-3 py-2 text-[12.5px] text-fg-70">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber" aria-hidden />
      {text}
    </p>
  )
}

interface ViewProps {
  cursor: string
  today: string
  byDay: Map<string, LumeTaskRow[]>
  loading: boolean
  onDay: (date: string) => void
  onTask: (id: string) => void
}

function Chip({ task, onTask }: { task: LumeTaskRow; onTask: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onTask(task.id)
      }}
      title={`${task.title} — ${STATUS_LABEL[task.status]}`}
      className={cn('block w-full truncate rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-tight', STATUS_TONE[task.status])}
    >
      {!task.all_day && <span className="mr-1 font-mono opacity-70">{timeFmt.format(new Date(task.due_at))}</span>}
      {task.title}
    </button>
  )
}

function MonthGrid({ cursor, today, byDay, loading, onDay, onTask }: ViewProps) {
  const weeks = monthGrid(cursor)
  return (
    <GlassCard className="gap-0 p-0 py-0" aria-busy={loading || undefined}>
      <div className="grid grid-cols-7 border-b border-line text-[11px] text-fg-46" aria-hidden>
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-1.5">{d}</div>
        ))}
      </div>
      <div role="grid" aria-label={monthLabel(cursor)} className="grid grid-cols-7">
        {weeks.flat().map((day) => {
          const list = byDay.get(day.date) ?? []
          const isToday = day.date === today
          return (
            <div
              key={day.date}
              role="gridcell"
              tabIndex={0}
              aria-label={`${dayLabel(day.date)}, ${list.length} task${list.length === 1 ? '' : 's'}`}
              onClick={() => onDay(day.date)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onDay(day.date)
                }
              }}
              className={cn(
                'flex min-h-[96px] cursor-pointer flex-col gap-1 border-r border-b border-line p-1.5 outline-none hover:bg-white/4 focus-visible:ring-2 focus-visible:ring-ring/50 [&:nth-child(7n)]:border-r-0',
                !day.inMonth && 'bg-black/10 text-fg-46',
                isToday && 'bg-lime/6'
              )}
            >
              <span
                className={cn(
                  'inline-flex size-6 items-center justify-center self-start rounded-full text-[12px]',
                  isToday ? 'bg-primary font-semibold text-primary-foreground' : day.inMonth ? 'text-fg-70' : 'text-fg-46'
                )}
              >
                {Number(day.date.slice(8))}
              </span>
              {list.slice(0, MAX_CHIPS).map((t) => (
                <Chip key={t.id} task={t} onTask={onTask} />
              ))}
              {list.length > MAX_CHIPS && <span className="px-1 text-[10.5px] text-fg-46">+{list.length - MAX_CHIPS} more</span>}
            </div>
          )
        })}
      </div>
    </GlassCard>
  )
}

function Agenda({ cursor, today, byDay, loading, onDay, onTask }: ViewProps) {
  const month = cursor.slice(0, 7)
  const days = [...byDay.keys()].filter((d) => d.startsWith(month))
  if (today.startsWith(month) && !days.includes(today)) days.push(today)
  days.sort()
  if (loading) return <p className="text-[13px] text-fg-46">Loading…</p>
  if (!days.length) return <p className="text-[13px] text-fg-46">Nothing scheduled in {monthLabel(cursor)}.</p>
  return (
    <ol className="flex flex-col gap-3">
      {days.map((d) => {
        const list = byDay.get(d) ?? []
        return (
          <li key={d} className={cn('flex flex-col gap-1.5', d < today && 'opacity-60')}>
            <div className="flex items-center gap-2">
              <h3 className={cn('text-[12.5px] font-semibold', d === today ? 'text-positive' : 'text-fg-70')}>
                {d === today ? `Today · ${dayLabel(d)}` : dayLabel(d)}
              </h3>
              <Button variant="ghost" size="icon-xs" aria-label={`Add a task on ${dayLabel(d)}`} onClick={() => onDay(d)}>
                <Plus />
              </Button>
            </div>
            {list.length === 0 ? (
              <p className="text-[12px] text-fg-46">Nothing due.</p>
            ) : (
              list.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onTask(t.id)}
                  className="flex min-h-11 items-center gap-3 rounded-panel border border-line bg-white/4 px-3 py-2 text-left hover:bg-white/6"
                >
                  <span className="w-14 shrink-0 font-mono text-[11.5px] text-fg-46">{t.all_day ? 'all day' : timeFmt.format(new Date(t.due_at))}</span>
                  <span className={cn('min-w-0 flex-1 truncate text-[13.5px] text-fg', t.status === 'cancelled' && 'line-through text-fg-46')}>{t.title}</span>
                  <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[10.5px]', STATUS_TONE[t.status])}>{STATUS_LABEL[t.status]}</span>
                </button>
              ))
            )}
          </li>
        )
      })}
    </ol>
  )
}

function CreateDialog({ date, onClose, onSaved }: { date: string | null; onClose: () => void; onSaved: () => void }) {
  return (
    <Dialog open={!!date} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">{date && <CreateForm key={date} date={date} onClose={onClose} onSaved={onSaved} />}</DialogContent>
    </Dialog>
  )
}

function CreateForm({ date: initialDate, onClose, onSaved }: { date: string; onClose: () => void; onSaved: () => void }) {
  const id = useId()
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [date, setDate] = useState(initialDate)
  const [time, setTime] = useState('')
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const valid = title.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(date)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid || state.busy) return
    setState({ busy: true, error: null })
    const a = await createTask({ title: title.trim(), ...(notes.trim() ? { notes: notes.trim() } : {}), due: dueOf(date, time) })
    if (a.status === 201 && a.body?.ok) {
      onSaved()
      onClose()
    } else setState({ busy: false, error: taskErrorText(a) })
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>New task</DialogTitle>
        <DialogDescription>Also created in Linear (project Lume). Without a time it is all day.</DialogDescription>
      </DialogHeader>
      <label className="flex flex-col gap-1 text-[12px] text-fg-70" htmlFor={`${id}-title`}>
        Title
        <Input id={`${id}-title`} autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] text-fg-70" htmlFor={`${id}-notes`}>
        Notes
        <Textarea id={`${id}-notes`} rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-fg-70" htmlFor={`${id}-date`}>
          Date
          <DatePicker id={`${id}-date`} value={date} onChange={setDate} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-fg-70" htmlFor={`${id}-time`}>
          Time (PT, optional)
          <Input id={`${id}-time`} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      <DialogFooter className="items-center">
        <p role="status" aria-live="polite" className="min-h-[16px] flex-1 text-[12px] text-amber">
          {state.error}
        </p>
        <Button type="submit" disabled={!valid || state.busy} aria-busy={state.busy || undefined}>
          {state.busy && <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />}
          Schedule
        </Button>
      </DialogFooter>
    </form>
  )
}

function TaskSheet({ task, open, onOpenChange, onSaved }: { task: LumeTaskRow | null; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto border-line bg-panel sm:max-w-md">
        {task ? (
          <TaskDetail key={`${task.id}:${task.updated_at}`} task={task} onSaved={onSaved} />
        ) : (
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Task</SheetTitle>
            <SheetDescription>Loading…</SheetDescription>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  )
}

function TaskDetail({ task, onSaved }: { task: LumeTaskRow; onSaved: () => void }) {
  const id = useId()
  const [resched, setResched] = useState(false)
  const [date, setDate] = useState(ownerDate(task.due_at))
  const [time, setTime] = useState(task.all_day ? '' : timeInputFmt.format(new Date(task.due_at)))
  const [state, setState] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null })
  const filed = task.status === 'awaiting_tap' || task.status === 'running'

  async function run(p: ReturnType<typeof patchTask>) {
    setState({ busy: true, msg: null })
    const a = await p
    if (a.status === 200 && a.body?.ok) {
      setState({ busy: false, msg: a.body.note ?? null })
      onSaved()
    } else setState({ busy: false, msg: taskErrorText(a) })
  }

  const reschedule = () =>
    run(patchTask(task.id, { due: dueOf(date, time), ...(task.status === 'failed' || task.status === 'cancelled' ? { status: 'scheduled' } : {}) }))

  return (
    <div className="flex min-h-full flex-col">
      <SheetHeader className="px-5 pt-5">
        <SheetTitle className="pr-6">{task.title}</SheetTitle>
        <SheetDescription className="text-fg-46">{dueText(task)}</SheetDescription>
      </SheetHeader>
      <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2.5 px-5 text-[12.5px]">
        <dt className="text-fg-46">Status</dt>
        <dd>
          <span className={cn('rounded-full border px-2 py-0.5 text-[11px]', STATUS_TONE[task.status])}>{STATUS_LABEL[task.status]}</span>
        </dd>
        <dt className="text-fg-46">Tag</dt>
        <dd>
          <TagChip table="lume_tasks" id={task.id} verticalId={task.vertical_id} onChanged={onSaved} className="text-[12px]" />
        </dd>
        {task.notes && (
          <>
            <dt className="text-fg-46">Notes</dt>
            <dd className="whitespace-pre-wrap text-fg-70">{task.notes}</dd>
          </>
        )}
        <dt className="text-fg-46">Action</dt>
        <dd className="text-fg-70">
          {task.action_kind ? (
            <>
              <span className="font-mono">{task.action_kind}</span>
              {task.action_id ? (
                <Link href={`/actions/${task.action_id}`} className="ml-2 link-accent">
                  Open approval
                </Link>
              ) : (
                <span className="block text-[11.5px] text-fg-46">Filed for your tap when due; nothing runs on its own.</span>
              )}
            </>
          ) : (
            'Reminder only'
          )}
        </dd>
        {task.last_error && (
          <>
            <dt className="text-fg-46">Note</dt>
            <dd className="text-amber">{task.last_error}</dd>
          </>
        )}
        <dt className="text-fg-46">Linear</dt>
        <dd className="text-fg-70">
          {task.linear_url ? (
            <a href={task.linear_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 link-accent">
              {task.linear_identifier ?? 'Open issue'} <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : (
            <span className="text-fg-46">{task.linear_error ? `Not synced: ${task.linear_error}` : 'Syncing…'}</span>
          )}
        </dd>
        <dt className="text-fg-46">Created</dt>
        <dd className="text-fg-70">by {task.created_by === 'agent' ? 'the agent' : 'you'}</dd>
      </dl>

      {resched && (
        <div className="mt-4 grid grid-cols-2 gap-3 px-5">
          <label className="flex flex-col gap-1 text-[12px] text-fg-70" htmlFor={`${id}-date`}>
            Date
            <DatePicker id={`${id}-date`} value={date} onChange={setDate} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-fg-70" htmlFor={`${id}-time`}>
            Time (PT, optional)
            <Input id={`${id}-time`} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
      )}

      <SheetFooter className="px-5 pb-5">
        <p role="status" aria-live="polite" className="min-h-[16px] text-[12px] text-amber">
          {state.msg}
        </p>
        <div className="flex flex-wrap gap-2">
          {resched ? (
            <Button disabled={state.busy || !date} onClick={reschedule}>
              {state.busy && <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />}
              Save date
            </Button>
          ) : (
            <>
              {task.status !== 'done' && task.status !== 'cancelled' && (
                <Button disabled={state.busy} onClick={() => run(patchTask(task.id, { status: 'done' }))}>
                  Mark done
                </Button>
              )}
              {!filed && task.status !== 'done' && (
                <Button variant="outline" disabled={state.busy} onClick={() => setResched(true)}>
                  Reschedule
                </Button>
              )}
              {task.status !== 'done' && task.status !== 'cancelled' && (
                <Button variant="destructive" disabled={state.busy} onClick={() => run(cancelTask(task.id))}>
                  Cancel task
                </Button>
              )}
            </>
          )}
        </div>
      </SheetFooter>
    </div>
  )
}
