'use client'

import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { Loader2, RefreshCw } from 'lucide-react'
import { ShimmerBar } from '@/components/overview/parts'
import { StatusBadge } from '@/components/import/StatusBadge'
import type { CampaignView } from '@/hooks/useCampaigns'
import { errorText, syncCampaigns } from '@/lib/rules/client'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')

export interface CampaignCardsProps {
  campaigns: CampaignView[] | undefined
  error?: unknown
  selectedId: string | null
  onSelect: (c: CampaignView) => void
  /** Keyboard / no-drag path: assign the current bundle to this campaign. */
  onAssignHere: (c: CampaignView) => void
  bundleLabel: string
  busyId: string | null
  onSynced: () => void
}

/** Drop targets: one card per campaign that has an external id (Instantly, or a seeded Gmail/Muse row). */
export function CampaignCards(p: CampaignCardsProps) {
  const [sync, setSync] = useState<{ state: 'idle' | 'busy' } | { state: 'done' | 'error'; text: string }>({ state: 'idle' })
  const list = (p.campaigns ?? []).filter((c) => c.external_id)

  async function runSync() {
    setSync({ state: 'busy' })
    const a = await syncCampaigns()
    if (a.status === 200 && a.body?.configured === false) setSync({ state: 'error', text: 'Instantly is not configured.' })
    else if (a.status === 200 && a.body?.ok) {
      setSync({ state: 'done', text: `${a.body.total ?? 0} campaigns synced (${a.body.inserted ?? 0} new).` })
      p.onSynced()
    } else setSync({ state: 'error', text: errorText(a) })
  }

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Campaigns">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-fg">Campaigns</h2>
        <button
          type="button"
          onClick={runSync}
          disabled={sync.state === 'busy'}
          className="inline-flex items-center gap-1.5 text-[12px] text-fg-46 hover:text-fg disabled:opacity-50"
        >
          {sync.state === 'busy' ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
          Sync from Instantly
        </button>
      </div>
      <p role="status" aria-live="polite" className={cn('min-h-[16px] text-[11px]', sync.state === 'error' ? 'text-amber' : 'text-fg-46')}>
        {'text' in sync ? sync.text : ''}
      </p>
      {p.campaigns === undefined && p.error == null ? (
        [0, 1].map((i) => <ShimmerBar key={i} className="h-24 w-full rounded-panel" />)
      ) : p.error != null && !p.campaigns ? (
        <p className="text-[12px] text-amber">Couldn&apos;t load campaigns.</p>
      ) : list.length === 0 ? (
        <p className="surface rounded-panel px-[18px] py-6 text-center text-[12px] text-fg-46">No campaigns yet — sync from Instantly.</p>
      ) : (
        list.map((c) => (
          <CampaignCard
            key={c.id}
            c={c}
            selected={p.selectedId === c.id}
            busy={p.busyId === c.id}
            onSelect={() => p.onSelect(c)}
            onAssignHere={() => p.onAssignHere(c)}
            bundleLabel={p.bundleLabel}
          />
        ))
      )}
    </section>
  )
}

function CampaignCard({
  c,
  selected,
  busy,
  onSelect,
  onAssignHere,
  bundleLabel,
}: {
  c: CampaignView
  selected: boolean
  busy: boolean
  onSelect: () => void
  onAssignHere: () => void
  bundleLabel: string
}) {
  const { setNodeRef, isOver, active } = useDroppable({ id: `campaign:${c.id}`, data: { campaign: c } })
  const accounts = typeof c.instantly?.accounts === 'number' ? c.instantly.accounts : null
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'glass relative flex flex-col gap-2 rounded-panel px-[16px] py-[14px] transition-[box-shadow,transform] duration-150',
        selected && 'ring-1 ring-violet/50',
        active && 'ring-1 ring-dashed ring-violet/30',
        isOver && 'scale-[1.01] ring-2 ring-violet'
      )}
    >
      <button type="button" onClick={onSelect} className="flex items-start justify-between gap-2 text-left" aria-pressed={selected}>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-fg">{c.name}</div>
          <div className="text-[11px] text-fg-46 capitalize">
            {c.sender_type} · {c.family}
          </div>
        </div>
        <StatusBadge status={c.status} />
      </button>
      <dl className="grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <dt className="text-fg-46">Capacity/day</dt>
          <dd className="font-mono text-fg">{c.capacity_per_day != null ? fmt.format(c.capacity_per_day) : '—'}</dd>
        </div>
        <div>
          <dt className="text-fg-46">Accounts</dt>
          <dd className="font-mono text-fg">{accounts != null ? fmt.format(accounts) : '—'}</dd>
        </div>
        <div>
          <dt className="text-fg-46">Queued</dt>
          <dd className="font-mono text-fg">{fmt.format(c.queued)}</dd>
        </div>
      </dl>
      <div className="flex items-center justify-between gap-2">
        <span className={cn('text-[11px]', c.rotator ? 'text-green' : 'text-fg-46')}>
          {c.rotator ? 'Drained by instantly-rotate' : 'No rotator for this campaign yet — queued leads wait'}
        </span>
        <button
          type="button"
          onClick={onAssignHere}
          disabled={busy}
          className="shrink-0 text-[11px] text-violet-soft hover:text-fg disabled:opacity-50"
        >
          {busy ? 'Sending…' : `Assign ${bundleLabel} here`}
        </button>
      </div>
      {isOver && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-panel bg-violet/10 text-[12px] font-medium text-fg">
          Drop to ask for confirmation
        </div>
      )}
    </div>
  )
}
