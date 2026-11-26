import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PageHead } from '@/components/shell/PageHead'
import { SignalsInbox } from '@/components/signals/SignalsInbox'
import { SignalsNav } from '@/components/signals/SignalsNav'
import { requireOwner } from '@/lib/auth/guards'
import { SIGNAL_SOURCES, type SignalSource } from '@/lib/signals/merge'
import { loadInbox } from '@/lib/signals/store'

export const metadata: Metadata = { title: 'Signals' }
export const dynamic = 'force-dynamic'

/** `/signals`: one inbox, one row per company, across every signal source. `?source=` opens it filtered. */
export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ source?: string }> }) {
  const auth = await requireOwner()
  if (!auth.ok) notFound()
  const wanted = (await searchParams).source
  const source = (SIGNAL_SOURCES as readonly string[]).includes(wanted ?? '') ? (wanted as SignalSource) : undefined
  // The filtered view starts from its own fetch; the full inbox renders from the server's rows.
  const initial = source ? undefined : await loadInbox()
  return (
    <>
      <PageHead title="Signals" actions={<SignalsNav current="inbox" />} />
      <SignalsInbox key={source ?? 'all'} initial={initial} defaultSource={source} />
    </>
  )
}
