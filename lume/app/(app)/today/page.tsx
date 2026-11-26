import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PageHead } from '@/components/shell/PageHead'
import { TodayScreen } from '@/components/today/TodayScreen'
import { requireOwner } from '@/lib/auth/guards'
import { loadToday } from '@/lib/today/store'

export const metadata: Metadata = { title: 'Today' }
export const dynamic = 'force-dynamic'

/** `/today`: the week's scoreboard and the queue of what needs doing now. */
export default async function TodayPage() {
  const auth = await requireOwner()
  if (!auth.ok) notFound()
  return (
    <>
      <PageHead title="Today" />
      <TodayScreen initial={await loadToday()} />
    </>
  )
}
