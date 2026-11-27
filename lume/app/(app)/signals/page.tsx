import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { SignalsInbox } from '@/components/signals/SignalsInbox'
import { requireOwner } from '@/lib/auth/guards'
import { SIGNAL_SOURCES, type SignalSource } from '@/lib/signals/merge'
import { loadInbox } from '@/lib/signals/store'

export const metadata: Metadata = { title: 'Signals' }
export const dynamic = 'force-dynamic'

/** Old `?source=` links for sources that now have their own tab. */
const TAB_OF: Partial<Record<SignalSource, string>> = {
  comment: '/signals/comments',
  reddit: '/signals/reddit',
  hiring: '/signals/hiring',
}

/**
 * `/signals` (the All tab): one row per company across every source.
 * `?source=comment|reddit|hiring` lands on that source's tab; `?source=influencer`
 * (influencer reactors) opens All filtered to them.
 */
export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ source?: string }> }) {
  const auth = await requireOwner()
  if (!auth.ok) notFound()
  const wanted = (await searchParams).source
  const source = (SIGNAL_SOURCES as readonly string[]).includes(wanted ?? '') ? (wanted as SignalSource) : undefined
  if (source && TAB_OF[source]) redirect(TAB_OF[source])
  // The filtered view starts from its own fetch; the full inbox renders from the server's rows.
  const initial = source ? undefined : await loadInbox()
  return <SignalsInbox key={source ?? 'all'} initial={initial} defaultSource={source} />
}
