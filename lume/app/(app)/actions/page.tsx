import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHead } from '@/components/shell/PageHead'
import { ApprovalsList } from '@/components/approvals/ApprovalsList'
import { requireOwner } from '@/lib/auth/guards'
import { listAwaitingActions } from '@/lib/approvals/store'
import { listDecidedSince } from '@/lib/actions/store'
import { capOf, formatUsd, kindLabel, toApprovalItem } from '@/lib/approvals/view'
import { OWNER_TZ } from '@/lib/time/owner'

export const metadata: Metadata = { title: 'Approvals' }
export const dynamic = 'force-dynamic'

const HISTORY_DAYS = 7
const HISTORY_LIMIT = 15
const whenFmt = new Intl.DateTimeFormat('en-US', { timeZone: OWNER_TZ, dateStyle: 'medium', timeStyle: 'short' })

/**
 * `/actions`: one list of every pending action of every kind (company checks,
 * Apify runs, pushes, replies, …) with its cap and Confirm / Cancel, and the
 * last week's decisions below. Decisions go through `/api/actions/<id>/decide`.
 */
export default async function ApprovalsPage() {
  const auth = await requireOwner()
  if (!auth.ok) notFound()
  const [{ rows, count }, decided] = await Promise.all([
    listAwaitingActions(),
    listDecidedSince(new Date(Date.now() - HISTORY_DAYS * 86_400_000), HISTORY_LIMIT),
  ])

  return (
    <>
      <PageHead eyebrow="Pending actions" title="Approvals" sub="Everything waiting for your Confirm, of every kind. Nothing runs until you press it — here or in Telegram." />
      <ApprovalsList initial={{ count, items: rows.map(toApprovalItem) }} />
      {decided.length > 0 && (
        <section aria-label="Recently decided" className="mt-8 flex flex-col gap-2">
          <h2 className="text-[13px] font-medium text-fg-70">Recently decided</h2>
          <ul className="surface flex flex-col divide-y divide-line rounded-2xl">
            {decided.map((r) => {
              const cap = capOf(r.kind, r.payload)
              return (
                <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2 text-[12.5px]">
                  <Link href={`/actions/${r.id}`} className="min-w-0 flex-1 truncate text-fg hover:underline">
                    {typeof r.payload?.summary === 'string' ? r.payload.summary : kindLabel(r.kind)}
                  </Link>
                  <span className="text-fg-46">{kindLabel(r.kind)}</span>
                  {cap !== null && <span className="font-mono text-fg-46">cap {formatUsd(cap)}</span>}
                  <span className="capitalize text-fg-70">{r.status}</span>
                  <span className="text-fg-46">{r.decided_at ? `${whenFmt.format(new Date(r.decided_at))} PT` : ''}</span>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </>
  )
}
