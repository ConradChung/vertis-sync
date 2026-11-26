import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHead } from '@/components/shell/PageHead'
import { RepliesList } from '@/components/replies/RepliesList'
import { requireOwner } from '@/lib/auth/guards'
import { loadReplies } from '@/lib/replies/store'

export const metadata: Metadata = { title: 'Replies' }
export const dynamic = 'force-dynamic'

/**
 * `/replies`: everything waiting on the owner in one list — pending approvals
 * of every kind and positive inbox replies nobody has answered — each showing
 * how long it has waited, flagged past 60 minutes. `/actions` (the approvals
 * list with its history) and `/actions/<id>` are unchanged.
 */
export default async function RepliesPage() {
  const auth = await requireOwner()
  if (!auth.ok) notFound()
  const initial = await loadReplies()
  return (
    <>
      <PageHead
        title="Replies"
        actions={
          <Link href="/actions" className="text-[13px] text-fg-70 hover:text-fg">
            Approval history
          </Link>
        }
      />
      <RepliesList initial={initial} />
    </>
  )
}
