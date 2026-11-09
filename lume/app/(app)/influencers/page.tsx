import { redirect } from 'next/navigation'

/** The Influencers tab is gone (owner, 2026-11-09): candidate lists are sheets in Leads. Old links land there. */
export default function InfluencersRedirect() {
  redirect('/import/leads')
}
