'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { decideAction, type Decision } from '@/components/actions/decide'
import { usePendingActions, type PendingResponse } from '@/hooks/usePendingCount'
import { ageOf, formatUsd, type ApprovalItem } from '@/lib/approvals/view'
import { cn } from '@/lib/utils'

/**
 * `/actions`: every awaiting pending action of every kind, newest first, with
 * its cap and Confirm / Cancel (the same decide route as `/actions/<id>`).
 * Starts from the server's rows, then polls with the nav badge's SWR key.
 */
export function ApprovalsList({ initial }: { initial: PendingResponse }) {
  const { data, mutate } = usePendingActions({ fallbackData: initial })
  const items = data?.items ?? []
  const count = data?.count ?? items.length
  // Re-render ages once a minute.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  if (!items.length) {
    return <p className="surface rounded-2xl px-4 py-6 text-center text-[13px] text-fg-46">Nothing waiting for you.</p>
  }

  return (
    <section aria-label="Waiting for your decision" className="flex flex-col gap-2">
      <p className="text-[12px] text-fg-46">
        {count} waiting{count > items.length ? ` · showing the newest ${items.length}` : ''}
      </p>
      <ul className="flex flex-col gap-2">
        {items.map((it) => (
          <ApprovalRow key={it.id} item={it} now={now} onDecided={() => void mutate()} />
        ))}
      </ul>
    </section>
  )
}

export function ApprovalRow({ item, now = new Date(), onDecided }: { item: ApprovalItem; now?: Date; onDecided?: () => void }) {
  const router = useRouter()
  const [busy, setBusy] = useState<Decision | null>(null)

  async function decide(decision: Decision) {
    setBusy(decision)
    try {
      await decideAction(item.id, decision)
    } finally {
      setBusy(null)
      onDecided?.()
      router.refresh()
    }
  }

  return (
    <li className="glass flex flex-col gap-2 rounded-2xl px-4 py-3" data-kind={item.kind}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="eyebrow">{item.label}</span>
        <span className="text-[11.5px] text-fg-46">
          {item.requested_by} · {ageOf(item.created_at, now)}
        </span>
      </div>
      <p className="line-clamp-3 text-[13.5px] leading-snug text-fg">{item.summary}</p>
      {(item.cap_usd !== null || item.estimate_usd !== null) && (
        <p className="font-mono text-[12px] text-fg-70 tabular-nums">
          {item.cap_usd !== null && <span>cap {formatUsd(item.cap_usd)}</span>}
          {item.cap_usd !== null && item.estimate_usd !== null && ' · '}
          {item.estimate_usd !== null && <span>estimate {formatUsd(item.estimate_usd)}</span>}
        </p>
      )}
      {item.notify_warning && (
        <p role="status" className="text-[12px] text-amber">
          {item.notify_warning}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link href={`/actions/${item.id}`} className={cn('mr-auto text-[12.5px] text-fg-46 hover:text-fg')}>
          Open
        </Link>
        {!item.open_only && (
          <>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void decide('reject')}>
              {busy === 'reject' ? 'Cancelling…' : 'Cancel'}
            </Button>
            <Button size="sm" disabled={busy !== null} onClick={() => void decide('approve')}>
              {busy === 'approve' ? 'Running…' : 'Confirm'}
            </Button>
          </>
        )}
        {item.open_only && <span className="text-[12px] text-fg-46">Decide on its page</span>}
      </div>
    </li>
  )
}
