import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { OverviewScreen } from '@/components/overview/OverviewScreen'

export const metadata: Metadata = { title: 'Overview' }

export default function OverviewPage() {
  return (
    <>
      <PageHead eyebrow="Today" title="Overview" sub="Every pipeline, one glance." />
      <OverviewScreen />
    </>
  )
}
