import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { InfluencersList } from '@/components/signals/InfluencersList'
import { SignalsNav } from '@/components/signals/SignalsNav'

export const metadata: Metadata = { title: 'Influencers' }

/** `/signals/influencers`: the influencers page's place inside Signals (`/influencers` lands here). */
export default function SignalsInfluencersPage() {
  return (
    <>
      <PageHead title="Influencers" actions={<SignalsNav current="influencers" />} />
      <InfluencersList />
    </>
  )
}
