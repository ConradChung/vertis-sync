import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { InfluencerRoster } from '@/components/influencers/InfluencerRoster'

export const metadata: Metadata = { title: 'Influencers' }

export default function InfluencersPage() {
  return (
    <>
      <PageHead
        eyebrow="PM influencer reactions"
        title="Influencers"
        sub="The people whose post reactions the pipeline mines: switch them on or off, see their last run. Candidate lists are sheets in Leads."
      />
      <InfluencerRoster />
    </>
  )
}
