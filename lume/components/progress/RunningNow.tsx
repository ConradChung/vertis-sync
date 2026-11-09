'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Bot, Briefcase, ChevronRight, ExternalLink, Search, ShieldCheck, ShoppingCart, Users, type LucideIcon } from 'lucide-react'
import { JobProgress } from '@/components/validate/JobProgress'
import { TagChip } from '@/components/tags/TagChip'
import { PROGRESS_KEY } from '@/hooks/useProgress'
import { ago } from '@/lib/import/format'
import { formatEta } from '@/lib/validate/client'
import type { ProgressItem, ProgressKind, ProgressPayload } from '@/lib/progress/model'
import { cn } from '@/lib/utils'

const ICON: Record<ProgressKind, LucideIcon> = {
  validation: ShieldCheck,
  apify: Bot,
  influencer_run: Users,
  influencer_lookup: Search,
  leadsfriday_order: ShoppingCart,
  job_batch: Briefcase,
}

const fmt = new Intl.NumberFormat('en-US')
const usd = (v: number) => `$${v.toFixed(2)}`

/** Re-render every 15 s so ETAs count down between polls. */
function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function OpenLink({ item }: { item: ProgressItem }) {
  if (!item.href) return null
  const cls = 'inline-flex items-center gap-1 text-[11.5px] text-violet-soft hover:text-fg'
  return item.external ? (
    <a href={item.href} target="_blank" rel="noopener noreferrer" className={cls}>
      Open <ExternalLink className="size-3" aria-hidden />
    </a>
  ) : (
    <Link href={item.href} className={cls}>
      Open <ChevronRight className="size-3" aria-hidden />
    </Link>
  )
}

/** One live (or recently finished) process: kind, title, status / stage, bar, ETA, cost, started, a link. */
export function ProgressCard({ item, now }: { item: ProgressItem; now: number }) {
  const Icon = ICON[item.kind]
  const pct = item.total ? Math.min(100, Math.round(((item.done ?? 0) / item.total) * 100)) : null
  const left = item.eta_seconds != null ? item.eta_seconds - (item.eta_updated_at ? Math.max(0, (now - Date.parse(item.eta_updated_at)) / 1000) : 0) : null
  const eta = left != null ? formatEta(left) : null
  const facts = [
    item.done != null ? (item.total ? `${fmt.format(item.done)} / ${fmt.format(item.total)}` : `${fmt.format(item.done)} so far`) : null,
    eta ? `${eta} left` : null,
    item.cost_usd != null ? `${usd(item.cost_usd)}${item.cap_usd != null ? ` of ${usd(item.cap_usd)}` : ''}${item.finished ? '' : ' so far'}` : null,
    `started ${ago(item.started_at)}`,
  ].filter(Boolean)
  return (
    <article role="group" aria-label={`${item.label}: ${item.title}`} className="flex flex-col gap-2 rounded-panel border border-line bg-white/4 px-4 py-3">
      <header className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-fg-46" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[11px] text-fg-46">
            {item.label}
            {(item.tag_table || item.vertical_id) && (
              <TagChip table={item.tag_table ?? null} id={item.key.slice(item.key.indexOf(':') + 1)} verticalId={item.vertical_id} name={item.vertical_name} revalidate={[PROGRESS_KEY]} />
            )}
          </p>
          <p className="truncate text-[13.5px] font-medium text-fg" title={item.title}>
            {item.title}
          </p>
        </div>
        <OpenLink item={item} />
      </header>
      <p className="text-[12px] text-fg-70">
        <span className={cn('font-mono', item.error ? 'text-red' : item.finished ? 'text-green' : 'text-cyan')}>{item.status}</span>
        {item.stage && item.stage !== item.status && <span> · {item.stage}</span>}
      </p>
      {pct !== null && (
        <div className="h-[5px] overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${item.title} progress`} aria-valuemin={0} aria-valuemax={item.total ?? 0} aria-valuenow={item.done ?? 0}>
          <i className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="text-[11px] text-fg-46 tabular-nums">{facts.join(' · ')}</p>
      {item.error && (
        <p className="text-[12px] text-red" role="note">
          {item.error}
        </p>
      )}
    </article>
  )
}

/**
 * Progress → "Running now": one card per live process, newest first
 * (validation jobs with their progress panel), then the last 24 h's
 * finished ones, collapsed, with any error.
 */
export function RunningNow({ data }: { data: ProgressPayload | undefined }) {
  const now = useNow()
  if (!data) return null
  const { running, recent } = data
  if (!running.length && !recent.length) return null
  return (
    <section aria-label="Running now" className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-fg">Running now</h2>
      {running.length ? (
        <div className="grid items-start gap-3 lg:grid-cols-2">
          {running.map((i) =>
            i.kind === 'validation' && i.job_id ? (
              <div key={i.key} className="flex flex-col gap-2">
                <ProgressCard item={i} now={now} />
                <JobProgress jobId={i.job_id} />
              </div>
            ) : (
              <ProgressCard key={i.key} item={i} now={now} />
            )
          )}
        </div>
      ) : (
        <p className="text-[12px] text-fg-46">Nothing is running right now.</p>
      )}
      {recent.length > 0 && (
        <details className="group rounded-panel border border-line bg-white/4 px-4 py-2.5">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-fg-70 select-none hover:text-fg [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
            Finished in the last 24 h ({recent.length})
          </summary>
          <div className="mt-2.5 grid gap-2.5 lg:grid-cols-2">
            {recent.map((i) => (
              <ProgressCard key={i.key} item={i} now={now} />
            ))}
          </div>
        </details>
      )}
      {data.unavailable?.length ? <p className="text-[11px] text-fg-24">Couldn&apos;t read: {data.unavailable.join(', ')} (retrying).</p> : null}
    </section>
  )
}
