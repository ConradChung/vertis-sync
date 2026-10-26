import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { CampaignsScreen } from '@/components/campaigns/CampaignsScreen'

export const metadata: Metadata = { title: 'Campaigns' }

export default function CampaignsPage() {
  return (
    <>
      <PageHead eyebrow="Stage 4" title="Campaigns" sub="Every campaign, its pipeline, and its replies — sends only after you confirm." />
      <CampaignsScreen />
    </>
  )
}
