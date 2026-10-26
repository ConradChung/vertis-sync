'use client'

import { AnimatedNumber } from '@/components/ui/animated-number'
import { OWNER_TZ } from '@/lib/time/owner'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { cn } from '@/lib/utils'
import { SequenceDiff } from '@/components/campaigns/SequenceDiff'
import type { StepDiff } from '@/lib/campaigns/sequence'

export interface ActionView {
  id: string
  kind: string
  summary: string
  details: [string, string][]
  /** update_sequence: the before/after per step and variant. */
  sequenceDiff?: StepDiff[]
  requestedBy: string
  status: string
  decidedVia: string | null
  decidedAt: string | null
  executedAt: string | null
  createdAt: string
  error: string | null
}

const TONE: Record<string, string> = {
  awaiting: 'bg-amber/12 text-amber border-amber/25',
  approved: 'bg-lime/15 text-positive border-transparent',
  executing: 'bg-lime/15 text-positive border-transparent',
  executed: 'bg-green/12 text-green border-green/25',
  rejected: 'bg-white/[.04] text-fg-46 border-line',
  expired: 'bg-white/[.04] text-fg-46 border-line',
  failed: 'bg-red/12 text-red border-red/25',
}

// Fixed locale + zone: the card is server-rendered, so a runtime-locale
// toLocaleString() would differ between server and browser (hydration).
const whenFmt = new Intl.DateTimeFormat('en-US', { timeZone: OWNER_TZ, dateStyle: 'medium', timeStyle: 'short' })
const when = (iso: string | null) => (iso ? `${whenFmt.format(new Date(iso))} PT` : '—')

/** A detail value that is just a number ("1,240", "12.5") counts up. */
function DetailValue({ v }: { v: string }) {
  const m = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/.exec(v.trim())
  if (!m) return <>{v}</>
  const n = Number(v.replaceAll(',', ''))
  const decimals = v.includes('.') ? v.split('.')[1].length : 0
  return <AnimatedNumber value={n} decimals={decimals} className="font-mono" />
}

/**
 * The plan card behind `/actions/<id>`. Confirm / Cancel are explicit clicks
 * (no hotkeys) and post to `/api/actions/<id>/decide`, which races Telegram
 * for the same claim. Anything not `awaiting` shows as already handled.
 */
export function ActionPlan({ action }: { action: ActionView }) {
  const router = useRouter()
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null)
  const awaiting = action.status === 'awaiting'

  async function decide(decision: 'approve' | 'reject') {
    setBusy(decision)
    try {
      const res = await fetch(`/api/actions/${action.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string | null }
      if (res.status === 409) toast.info('Already handled — someone decided this first')
      else if (!res.ok && res.status !== 202) toast.error(body.error ?? `Failed (${res.status})`)
      else if (decision === 'reject') toast.success('Cancelled')
      else if (res.status === 202) toast.info('Approved — still running')
      else if (body.status === 'failed') toast.error(`Failed: ${body.error ?? 'see details'}`)
      else toast.success('Done')
    } catch {
      toast.error('Network error')
    } finally {
      setBusy(null)
      router.refresh()
    }
  }

  return (
    <GlassCard className="mx-auto w-full max-w-2xl px-[18px]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="eyebrow">{action.kind.replaceAll('_', ' ')}</div>
          <p className="mt-2 text-[15px] leading-snug font-medium text-fg">{action.summary}</p>
        </div>
        <span
          className={cn(
            'inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-medium capitalize',
            TONE[action.status] ?? TONE.rejected
          )}
        >
          {action.status}
        </span>
      </div>

      {action.details.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          {action.details.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-46">{k.replaceAll('_', ' ')}</dt>
              <dd className="min-w-0 break-words whitespace-pre-wrap text-fg">
                <DetailValue v={String(v)} />
              </dd>
            </div>
          ))}
        </dl>
      )}

      {action.sequenceDiff && <SequenceDiff diff={action.sequenceDiff} />}

      <div className="text-[12px] text-fg-46">
        Requested by {action.requestedBy} · {when(action.createdAt)}
        {action.decidedAt && ` · decided in ${action.decidedVia ?? '—'} ${when(action.decidedAt)}`}
        {action.executedAt && ` · finished ${when(action.executedAt)}`}
      </div>

      {action.error && <p className="text-[13px] text-red">{action.error}</p>}

      {awaiting ? (
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy !== null} onClick={() => decide('reject')}>
            {busy === 'reject' ? 'Cancelling…' : 'Cancel'}
          </Button>
          <Button disabled={busy !== null} onClick={() => decide('approve')}>
            {busy === 'approve' ? 'Running…' : 'Confirm'}
          </Button>
        </div>
      ) : (
        <p className="text-[13px] text-fg-46">Already handled — nothing to confirm.</p>
      )}
    </GlassCard>
  )
}
