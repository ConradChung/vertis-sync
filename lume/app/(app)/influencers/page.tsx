import { redirect } from 'next/navigation'

/** Influencers live inside Signals (owner, 2026-11-26). Old links land there; candidate lists are still sheets in Leads. */
export default function InfluencersRedirect() {
  redirect('/signals/influencers')
}
