'use client'

import Link from 'next/link'
import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import type { VerticalCard } from '@/lib/operators/strip'
import { cn } from '@/lib/utils'

/** Relative time, coarse ("12 min ago"). */
function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never'
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const h = Math.round(mins / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}

/**
 * Overview "Verticals" strip (Phase G6): one card per vertical, linking to its
 * /operator check-in page. Last check-in turns red after 30 min (or never).
 */
export function VerticalStrip() {
  const { data, error } = useSWR<{ cards: VerticalCard[] }>('/api/overview/verticals', fetchJson, { refreshInterval: 60_000 })
  if (error) return <p className="text-sm text-muted-foreground">Verticals unavailable.</p>
  const cards = data?.cards ?? []
  if (data && !cards.length) return null
  return (
    <section aria-labelledby="verticals-strip" className="mb-6">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 id="verticals-strip" className="eyebrow">
          Verticals
        </h2>
        <Link href="/settings/verticals" className="text-xs text-muted-foreground hover:underline">
          Manage
        </Link>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {cards.map((c) => (
          <li key={c.id}>
            <Link href={`/operator?vertical=${c.id}`} className="block rounded-lg border border-border p-3 hover:border-primary/60">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{c.name}</span>
                {c.is_default && <span className="text-[10px] uppercase text-muted-foreground">default</span>}
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Check-in</dt>
                <dd className={cn('text-right', c.stale && 'text-destructive')} data-stale={c.stale || undefined}>
                  {c.bots ? ago(c.last_check_in) : 'no bot'}
                </dd>
                <dt className="text-muted-foreground">To confirm</dt>
                <dd className="text-right tabular-nums">{c.needs_confirmation}</dd>
                <dt className="text-muted-foreground">Alerts</dt>
                <dd className="text-right tabular-nums">{c.unacked_alerts}</dd>
              </dl>
              <p className="mt-2 truncate text-xs text-muted-foreground" title={c.last_bot_action?.summary}>
                {c.last_bot_action ? `Bot: ${c.last_bot_action.kind} (${c.last_bot_action.status}) ${ago(c.last_bot_action.decided_at)}` : 'No bot actions yet'}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
