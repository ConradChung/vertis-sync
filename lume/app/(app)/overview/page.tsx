import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'

export const metadata: Metadata = { title: 'Overview' }

export default function OverviewPage() {
  return (
    <>
      <PageHead eyebrow="Today" title="Overview" sub="Every pipeline, one glance." />
      {/* Task 8: KPIs, live feed, campaign health, scheduled jobs. */}
    </>
  )
}
