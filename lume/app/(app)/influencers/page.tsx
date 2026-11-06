import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { InfluencerCandidates } from '@/components/influencers/InfluencerCandidates'

export const metadata: Metadata = { title: 'Influencers' }

export default function InfluencersPage() {
  return (
    <>
      <PageHead
        eyebrow="PM influencer reactions"
        title="Influencer candidates"
        sub="Lists of names, their LinkedIn profiles found from cited sources, and your review. Approved people become inactive influencers; a run still needs its own estimate and approval."
      />
      <InfluencerCandidates />
    </>
  )
}
