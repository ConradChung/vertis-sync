'use client'

import Link from 'next/link'
import useSWR from 'swr'
import { ArrowUpRight, Check, Database, ExternalLink, X } from 'lucide-react'
import { fetchJson } from '@/hooks/fetcher'
import { GlassCard } from '@/components/ui/glass-card'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { AnimatedNumber } from '@/components/ui/animated-number'
import { cn } from '@/lib/utils'
import {
  apifyDatasetUrl,
  apifyRunUrl,
  costLines,
  countLines,
  isApifyPending,
  isRunLive,
  stageStates,
  usd,
  type LiveApifyRun,
  type LiveRun,
  type StageState,
} from '@/lib/influencers/runView'

interface RunPayload {
  run: LiveRun
  apify_runs?: (LiveApifyRun & { influencer_name?: string })[]
}

const POLL_MS = 4000

function StageMark({ state }: { state: StageState }) {
  return (
    <span className="relative flex size-6 shrink-0 items-center justify-center" aria-hidden>
      {state === 'active' && <span className="absolute inset-0 rounded-full bg-lime/25 motion-safe:animate-ping" />}
      <span
        className={cn(
          'relative flex size-6 items-center justify-center rounded-full',
          state === 'done' && 'bg-lime text-black',
          state === 'active' && 'bg-black shadow-[inset_0_0_0_2px_var(--lime)]',
          state === 'needs_you' && 'bg-black shadow-[inset_0_0_0_2.5px_var(--lime)]',
          state === 'failed' && 'bg-red/20 text-red shadow-[inset_0_0_0_2px_var(--red)]',
          state === 'todo' && 'bg-black/50 shadow-[inset_0_0_0_1.5px_var(--fg-24)]'
        )}
      >
        {state === 'done' && <Check className="size-3.5" strokeWidth={3} />}
        {state === 'failed' && <X className="size-3.5" strokeWidth={3} />}
        {state === 'active' && <span className="size-1.5 rounded-full bg-lime motion-safe:animate-pulse" />}
        {state === 'needs_you' && <span className="size-2 rounded-full bg-lime" />}
      </span>
    </span>
  )
}

function ApifyRow({ a }: { a: LiveApifyRun & { influencer_name?: string } }) {
  const pending = isApifyPending(a.status)
  return (
    <li className="flex flex-col gap-1.5 rounded-lg bg-white/[.03] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-[12px] text-fg">{a.actor_id ?? '—'}</div>
          <div className="text-[11px] text-fg-46">
            {a.kind}
            {a.influencer_name ? ` · ${a.influencer_name}` : ''}
          </div>
        </div>
        <span
          className={cn(
            'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium capitalize',
            pending && 'bg-lime/10 text-positive',
            a.status === 'succeeded' && 'bg-green/12 text-green',
            (a.status === 'failed' || a.status === 'aborted') && 'bg-red/12 text-red'
          )}
        >
          {pending && <Spinner className="size-3" />}
          {a.status}
        </span>
      </div>
      {pending ? (
        <div className="flex items-center gap-3" aria-label="Scraping">
          <Skeleton className="h-3 w-24 bg-white/[.06]" />
          <Skeleton className="h-3 w-14 bg-white/[.06]" />
        </div>
      ) : (
        <div className="flex gap-4 text-[12px] text-fg-46">
          <span>
            <span className="font-mono text-fg">{a.item_count ?? 0}</span> items
          </span>
          <span className="font-mono text-fg">{usd(a.cost_usd)}</span>
        </div>
      )}
      {a.error && <p className="text-[12px] break-words text-red">{a.error}</p>}
      {(a.apify_run_id || a.dataset_id) && (
        <div className="flex gap-3 text-[12px]">
          {a.apify_run_id && (
            <a href={apifyRunUrl(a.apify_run_id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">
              <ExternalLink className="size-3" /> Apify run
            </a>
          )}
          {a.dataset_id && (
            <a href={apifyDatasetUrl(a.dataset_id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">
              <Database className="size-3" /> Dataset
            </a>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * The live view under an approved influencer action's card: polls the run
 * every 4 s while the edge function can still move it (running / awaiting the
 * reactions bill), then stops. Read-only; every spend still waits on its own
 * pending action.
 */
export function InfluencerRunLive({ runId }: { runId: string }) {
  const { data, error } = useSWR<RunPayload>(`/api/influencers/runs/${runId}`, fetchJson, {
    refreshInterval: (latest) => (!latest || isRunLive(latest.run.status) ? POLL_MS : 0),
  })

  if (!data) {
    return (
      <GlassCard className="mx-auto mt-4 w-full max-w-2xl px-[18px]">
        <div className="eyebrow">Live run</div>
        {error ? (
          <p className="text-[13px] text-red">Could not load the run: {error instanceof Error ? error.message : String(error)}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-full bg-white/[.06]" />
            <Skeleton className="h-16 w-full bg-white/[.06]" />
          </div>
        )}
      </GlassCard>
    )
  }

  const { run } = data
  const stages = stageStates(run)
  const counts = countLines(run.counts)
  const cost = costLines(run.cost)
  const apify = data.apify_runs ?? []
  const live = isRunLive(run.status)

  return (
    <GlassCard className="mx-auto mt-4 w-full max-w-2xl px-[18px]">
      <div className="flex items-center justify-between gap-3">
        <div className="eyebrow">Live run</div>
        <span className="inline-flex items-center gap-1.5 text-[12px] text-fg-46">
          {live && <Spinner className="size-3 text-positive" />}
          {run.status.replaceAll('_', ' ')}
        </span>
      </div>

      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2" aria-label="Stages">
        {stages.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2" aria-current={s.state === 'active' || s.state === 'needs_you' ? 'step' : undefined}>
            <StageMark state={s.state} />
            <span className={cn('text-[12px]', s.state === 'todo' ? 'text-fg-46' : 'text-fg')}>{s.label}</span>
            {i < stages.length - 1 && <span className="h-px w-4 bg-white/12" aria-hidden />}
          </li>
        ))}
      </ol>

      {run.status === 'awaiting_approval' && <p className="text-[12px] text-fg-46">Waiting on your approval of the reactions bill.</p>}
      {run.error && <p className="text-[13px] whitespace-pre-wrap text-red">{run.error}</p>}

      {apify.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="text-[12px] text-fg-46">Apify</div>
          <ul className="flex flex-col gap-2">
            {apify.map((a) => (
              <ApifyRow key={`${a.influencer_id}:${a.kind}`} a={a} />
            ))}
          </ul>
        </section>
      )}

      {(counts.length > 0 || cost.length > 0) && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-3">
          {counts.map((c) => (
            <div key={c.key} className="flex items-baseline justify-between gap-2">
              <dt className="text-fg-46">{c.label}</dt>
              <dd>
                <AnimatedNumber value={c.value} className="font-mono text-fg" />
              </dd>
            </div>
          ))}
          {cost.map((c) => (
            <div key={`cost:${c.key}`} className="flex items-baseline justify-between gap-2">
              <dt className="text-fg-46">{c.key === 'total' ? 'cost total' : c.label}</dt>
              <dd className={cn('font-mono', c.key === 'total' ? 'text-positive' : 'text-fg')}>{c.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {run.status === 'done' && (
        <div className="flex justify-end">
          <Link href="/import/leads" className="inline-flex items-center gap-1 text-[13px] font-medium text-link hover:underline">
            Open in Leads <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
      )}
    </GlassCard>
  )
}
