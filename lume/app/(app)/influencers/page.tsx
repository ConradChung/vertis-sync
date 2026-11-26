import { redirect } from 'next/navigation'

/**
 * The Influencers tab is gone (owner, 2026-11-09): candidate lists are sheets in Leads, and old links
 * (the influencer-lookup alert's "Review the candidates in Lume") land there. The influencers
 * themselves have their place inside Signals at /signals/influencers.
 */
export default function InfluencersRedirect() {
  redirect('/import/leads')
}
