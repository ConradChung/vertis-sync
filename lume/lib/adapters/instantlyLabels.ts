import 'server-only'
import { InstantlyError } from '@/lib/adapters/instantly'
import { instantlyCall } from '@/lib/adapters/instantlyLeads'

/**
 * Instantly API v2, reply labels (inbox manager 3b): a lead's interest
 * status and the workspace blocklist. Low-tier writes that send nothing;
 * only lib/inbox/label.ts calls these, after the route's owner / scope
 * checks. 429s wait and retry (instantlyCall).
 *
 *  - `POST /leads/update-interest-status` `{ lead_email, campaign_id,
 *    interest_value }` (202; null resets to "Lead"). Instantly may mark the
 *    campaign lead completed for some values.
 *  - `POST /block-lists-entries` `{ bl_value }` (an email or a domain).
 */

export async function setInterestStatus(leadEmail: string, campaignId: string, value: number | null): Promise<void> {
  await instantlyCall('POST', '/leads/update-interest-status', { lead_email: leadEmail, campaign_id: campaignId, interest_value: value })
}

/** Block an address or domain. An entry that already exists counts as blocked. */
export async function addToBlocklist(value: string): Promise<'added' | 'already'> {
  try {
    await instantlyCall('POST', '/block-lists-entries', { bl_value: value })
    return 'added'
  } catch (err) {
    if (err instanceof InstantlyError && (err.status === 409 || (err.status === 400 && /exist|duplicate/i.test(err.message)))) return 'already'
    throw err
  }
}
