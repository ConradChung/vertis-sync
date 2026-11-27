import type { Metadata } from 'next'
import { InfluencersList } from '@/components/signals/InfluencersList'

export const metadata: Metadata = { title: 'Signals: influencers' }

/** `/signals/influencers`: the influencers whose post reactions are scraped. (`/influencers` still lands on the candidate lists in Leads.) */
export default function SignalsInfluencersPage() {
  return <InfluencersList />
}
