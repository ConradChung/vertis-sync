'use client'

import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import type { TagQueues } from '@/lib/rotation/queues'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })

interface QueuesPayload {
  tags: TagQueues[]
  in_instantly: number | null
  cap: number
  last_run_at: string | null
  next_run_at: string
}

/**
 * The lead bank by tag → campaign: what's queued for each campaign, what's in
 * Instantly, its place in line, and a warning when a paused campaign holds
 * slots (its leads never finish, so nothing else can rotate in).
 */
export function RotationQueues() {
  const { data, error } = useSWR<QueuesPayload>('/api/rotation/queues', fetchJson, { refreshInterval: 60_000 })
  if (error && !data) return <p className="text-[12px] text-fg-46">Couldn&apos;t load the lead bank queues.</p>
  if (!data) return <div className="h-28 animate-pulse rounded-2xl bg-(--glass-fill)" aria-label="Loading queues" />
  const full = data.in_instantly != null && data.in_instantly >= data.cap
  const blockers = data.tags.flatMap((t) => t.campaigns).filter((c) => c.active > 0 && /paused|stopped/i.test(c.status ?? ''))

  return (
    <section aria-label="Lead bank by tag" className="flex flex-col gap-3 rounded-2xl bg-(--glass-fill) p-4 backdrop-blur-xl sm:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="text-[15px] font-semibold text-fg">Lead bank → Instantly</h2>
        <p className="font-mono text-[11.5px] text-fg-46 tabular-nums">
          Instantly {data.in_instantly == null ? '—' : `${fmt.format(data.in_instantly)} / ${fmt.format(data.cap)}`}
          {full && <span className="text-amber"> · full</span>} · next rotation {when(data.next_run_at)} · oldest queued goes first
        </p>
      </header>
      {blockers.length > 0 && (
        <p className="rounded-xl bg-amber/10 px-3 py-2 text-[12.5px] text-fg">
          {blockers.map((b) => `“${b.name}”`).join(', ')} {blockers.length === 1 ? 'is' : 'are'} paused but holding {fmt.format(blockers.reduce((s, b) => s + b.active, 0))} Instantly
          slots. Paused leads never finish, so nothing else rotates in until {blockers.length === 1 ? 'it is' : 'they are'} resumed or {blockers.length === 1 ? 'its' : 'their'} leads are removed.
        </p>
      )}
      {data.tags.length === 0 && <p className="text-[12.5px] text-fg-46">The lead bank is empty.</p>}
      <div className="flex flex-col gap-4">
        {data.tags.map((t) => (
          <div key={t.tag_id ?? 'untagged'} className="flex flex-col gap-1.5">
            <p className="flex items-baseline gap-2 text-[11px] font-medium tracking-[0.1em] text-fg-46 uppercase">
              {t.tag}
              <span className="font-mono tracking-normal normal-case tabular-nums">
                {fmt.format(t.queued)} queued · {fmt.format(t.active)} in Instantly
              </span>
            </p>
            <ul className="flex flex-col gap-1">
              {t.campaigns.map((c) => (
                <li key={c.campaign_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 rounded-xl px-3 py-2 hover:bg-white/[0.04] sm:grid-cols-[minmax(0,1fr)_repeat(3,7.5rem)]">
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] text-fg">{c.name}</span>
                    <span className={cn('text-[11px]', /paused|stopped/i.test(c.status ?? '') ? 'text-amber' : 'text-fg-46')}>
                      {c.status ?? 'status unknown'}
                      {c.place != null && ` · #${c.place} in line`}
                    </span>
                  </span>
                  <span className="text-right font-mono text-[12px] text-fg tabular-nums">
                    {fmt.format(c.queued)} <span className="text-fg-46">queued</span>
                  </span>
                  <span className="hidden text-right font-mono text-[12px] text-fg tabular-nums sm:block">
                    {fmt.format(c.active)} <span className="text-fg-46">in Instantly</span>
                  </span>
                  <span className="hidden text-right font-mono text-[12px] text-fg-70 tabular-nums sm:block">
                    {fmt.format(c.finished)} <span className="text-fg-46">done</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
