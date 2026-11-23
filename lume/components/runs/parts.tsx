import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronLeft, ExternalLink } from 'lucide-react'
import { GlassCard } from '@/components/ui/glass-card'
import { OWNER_TZ } from '@/lib/time/owner'
import { statusText, statusTone, type SpendBar, type StatusTone } from '@/lib/runs/model'
import { cn } from '@/lib/utils'

/** Shared pieces of the run detail views (server-rendered, read-only). */

export const fmt = new Intl.NumberFormat('en-US')
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: OWNER_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export const when = (iso: string | null | undefined) => (iso ? dateFmt.format(new Date(iso)) : '—')

const TONE: Record<StatusTone, string> = {
  live: 'bg-cyan/10 text-cyan',
  ok: 'bg-green/12 text-green',
  bad: 'bg-red/12 text-red',
  idle: 'bg-white/[.06] text-fg-70',
}

export function StatusPill({ status }: { status: string | null | undefined }) {
  return <span className={cn('inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium', TONE[statusTone(status)])}>{statusText(status)}</span>
}

/** The page's one surface: back link, kind + status, then the sections. */
export function RunSurface({ kind, title, status, children }: { kind: string; title: string; status: string | null | undefined; children: ReactNode }) {
  return (
    <GlassCard className="mx-auto w-full max-w-5xl gap-6 px-[18px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/progress" className="inline-flex items-center gap-1 text-[12px] text-fg-46 hover:text-fg">
          <ChevronLeft className="size-3.5" aria-hidden /> Progress
        </Link>
        <span className="flex items-center gap-2 text-[11px] text-fg-46">
          {kind}
          <StatusPill status={status} />
        </span>
      </div>
      <h2 className="-mt-3 truncate text-[17px] font-semibold tracking-tight text-fg" title={title}>
        {title}
      </h2>
      {children}
    </GlassCard>
  )
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="eyebrow">{title}</div>
        {aside && <div className="text-[11px] text-fg-46">{aside}</div>}
      </div>
      {children}
    </section>
  )
}

/** Label / value pairs in a responsive grid; null values are skipped. */
export function Facts({ items }: { items: [string, ReactNode | null | undefined][] }) {
  const shown = items.filter(([, v]) => v !== null && v !== undefined && v !== '')
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
      {shown.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[11px] text-fg-46">{k}</dt>
          <dd className="mt-0.5 truncate font-mono text-[13px] text-fg tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] text-violet-soft hover:text-fg">
      {children} <ExternalLink className="size-3" aria-hidden />
    </a>
  )
}

/** A done / total bar (static: server-rendered). */
export function CountBar({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
        <span className="text-fg-70">{label}</span>
        <span className="font-mono text-fg tabular-nums">
          {fmt.format(done)} / {fmt.format(total)} <span className="text-fg-46">· {pct}%</span>
        </span>
      </div>
      <div className="h-[5px] overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <i className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** Spend against the approved cap, "$X of $Y". */
export function SpendMeter({ bar, label = 'Spent vs cap' }: { bar: SpendBar; label?: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
        <span className="text-fg-70">{label}</span>
        <span className={cn('font-mono tabular-nums', bar.over ? 'text-red' : 'text-fg')}>
          {bar.label}
          {bar.pct !== null && <span className="text-fg-46"> · {bar.pct}%</span>}
        </span>
      </div>
      {bar.pct !== null && (
        <div className="h-[5px] overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={bar.cap ?? 0} aria-valuenow={bar.spent}>
          <i className={cn('block h-full rounded-full', bar.over ? 'bg-red' : bar.pct >= 80 ? 'bg-amber' : 'bg-primary')} style={{ width: `${bar.pct}%` }} />
        </div>
      )}
    </div>
  )
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null
  return (
    <p className="rounded-lg bg-red/10 px-3 py-2 text-[12.5px] break-words text-red" role="note">
      {error}
    </p>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[12.5px] text-fg-46">{children}</p>
}
