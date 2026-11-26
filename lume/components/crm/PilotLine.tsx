'use client'

import { Check, HandHeart } from 'lucide-react'
import { DatePicker } from '@/components/ui/date-picker'
import type { PatchBody } from '@/lib/crm/client'
import { isDate, pilotCheckins, pilotDay, shortDate, type Checkin, type PilotFields } from '@/lib/crm/pilot'
import { ownerDate } from '@/lib/time/owner'
import { cn } from '@/lib/utils'

/** A deal shows its pilot once it has a start date or sits in Pilot. */
export const hasPilot = (d: PilotFields) => d.stage === 'Pilot' || isDate(d.pilot_start_date)

const checkinText = (c: Checkin) =>
  c.state === 'done' ? `Day ${c.day} done` : c.state === 'due' ? `Day ${c.day} due${c.days_late > 0 ? ` · ${c.days_late} d late` : ' today'}` : `Day ${c.day} · ${shortDate(c.due_date)}`

function Chip({ tone, children, title }: { tone: 'done' | 'due' | 'quiet'; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      data-tone={tone}
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-full px-2 text-[10.5px] whitespace-nowrap',
        // Neutral throughout; the accent marks only a check-in that is due.
        tone === 'done' && 'bg-secondary text-foreground',
        tone === 'due' && 'bg-primary font-medium text-primary-foreground',
        tone === 'quiet' && 'bg-secondary text-muted-foreground'
      )}
    >
      {children}
    </span>
  )
}

/**
 * The pilot on a deal card: when it started, the day-10 and day-25 check-ins
 * (done, due or upcoming) and whether a referral was asked for. Renders
 * nothing for a deal with no pilot.
 */
export function PilotLine({ deal: d, now }: { deal: PilotFields; now: number | Date }) {
  if (!hasPilot(d)) return null
  const today = ownerDate(now)
  const day = pilotDay(d.pilot_start_date, today)
  return (
    <div data-testid="pilot-line" className="flex flex-wrap items-center gap-1" aria-label="Pilot">
      <Chip tone="quiet" title={d.pilot_start_date ? `Pilot started ${d.pilot_start_date}` : 'No start date yet'}>
        {d.pilot_start_date && day !== null ? `Pilot · ${shortDate(d.pilot_start_date)} · day ${Math.max(day, 0)}` : 'Pilot · no start date'}
      </Chip>
      {pilotCheckins(d, today).map((c) => (
        <Chip key={c.day} tone={c.state === 'done' ? 'done' : c.state === 'due' ? 'due' : 'quiet'} title={`Check-in due ${c.due_date}`}>
          {c.state === 'done' && <Check className="size-3" strokeWidth={1.75} aria-hidden />}
          {checkinText(c)}
        </Chip>
      ))}
      <Chip tone={d.referral_asked_at ? 'done' : 'quiet'}>
        {d.referral_asked_at ? <Check className="size-3" strokeWidth={1.75} aria-hidden /> : <HandHeart className="size-3" strokeWidth={1.75} aria-hidden />}
        {d.referral_asked_at ? 'Referral asked' : 'Referral not asked'}
      </Chip>
    </div>
  )
}

const TICK = 'inline-flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

/**
 * The pilot's controls in the deal sheet: start date, the two check-in ticks
 * and the referral tick. Each is a manual note on the deal (stamped with the
 * time); nothing is sent to the customer. It sits in the sheet header as a
 * plain row group (no box of its own).
 */
export function PilotPanel({ deal: d, busy, onSave }: { deal: PilotFields; busy: boolean; onSave: (body: PatchBody, okText?: string) => Promise<boolean> | void }) {
  if (!hasPilot(d)) return null
  const today = ownerDate(new Date())
  const checkins = pilotCheckins(d, today)
  // Ticked is the neutral strong fill; the accent is kept for a check-in that is due.
  const tick = (on: boolean) => cn(TICK, on ? 'bg-foreground text-background' : 'bg-secondary text-foreground hover:bg-foreground/12')
  return (
    <section aria-label="Pilot" className="flex flex-col gap-3 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">Pilot</span>
        <DatePicker
          value={d.pilot_start_date ?? ''}
          onChange={(v) => {
            if (v === (d.pilot_start_date ?? '')) return
            void onSave({ pilot_start_date: v || null }, v ? 'Pilot start saved' : 'Pilot start cleared')
          }}
          size="sm"
          aria-label="Pilot start date"
          className="w-40"
        />
        {d.pilot_start_date && <span className="font-mono text-[11.5px] text-muted-foreground">day {Math.max(pilotDay(d.pilot_start_date, today) ?? 0, 0)}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {checkins.map((c) => (
          <button
            key={c.day}
            type="button"
            aria-pressed={c.state === 'done'}
            disabled={busy}
            title={`Due ${c.due_date}${c.done_at ? ` · done ${ownerDate(c.done_at)}` : ''}`}
            onClick={() => void onSave(c.day === 10 ? { pilot_checkin_10_done: c.state !== 'done' } : { pilot_checkin_25_done: c.state !== 'done' })}
            className={cn(tick(c.state === 'done'), c.state === 'due' && 'bg-primary font-medium text-primary-foreground hover:bg-primary/85')}
          >
            {c.state === 'done' && <Check className="size-3.5" strokeWidth={1.75} aria-hidden />}
            {checkinText(c)}
          </button>
        ))}
        {!checkins.length && <span className="text-[12px] text-muted-foreground">Set a start date to schedule the day-10 and day-25 check-ins.</span>}
        <button type="button" aria-pressed={!!d.referral_asked_at} disabled={busy} onClick={() => void onSave({ referral_asked: !d.referral_asked_at })} className={tick(!!d.referral_asked_at)}>
          <HandHeart className="size-3.5" strokeWidth={1.75} aria-hidden />
          {d.referral_asked_at ? `Referral asked ${shortDate(ownerDate(d.referral_asked_at))}` : 'Referral asked?'}
        </button>
      </div>
    </section>
  )
}
