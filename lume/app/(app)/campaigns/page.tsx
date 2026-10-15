import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'

export const metadata: Metadata = { title: 'Campaigns' }

export default function CampaignsPage() {
  return (
    <>
      <PageHead eyebrow="Stage 4" title="Campaigns" sub="Instantly campaigns, replies and health." />
      {/* Task 13: campaign table, stats, inbox. */}
    </>
  )
}
