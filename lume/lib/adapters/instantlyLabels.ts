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

const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? ''

/**
 * Is the address (or its domain) on the Instantly blocklist? Two reads of
 * `GET /block-lists-entries?search=` (the address, then the domain), matched
 * exactly here. Throws on an Instantly failure: callers fail closed.
 */
export async function isBlocked(email: string): Promise<boolean> {
  const addr = email.trim().toLowerCase()
  const domain = domainOf(addr)
  for (const term of [addr, domain].filter(Boolean)) {
    const body = (await instantlyCall('GET', `/block-lists-entries?search=${encodeURIComponent(term)}&limit=50`)) as { items?: { bl_value?: unknown }[] }
    for (const it of body.items ?? []) {
      const v = typeof it.bl_value === 'string' ? it.bl_value.trim().toLowerCase() : ''
      if (v && (v === addr || v === domain)) return true
    }
  }
  return false
}

/** Is this email a lead of that campaign in Instantly? (`POST /leads/list` with `campaign` + `contacts`; a read.) */
export async function leadInCampaign(email: string, campaignId: string): Promise<boolean> {
  const addr = email.trim().toLowerCase()
  const body = (await instantlyCall('POST', '/leads/list', { campaign: campaignId, contacts: [addr], limit: 5 })) as { items?: { email?: unknown; campaign?: unknown }[] }
  return (body.items ?? []).some((l) => typeof l.email === 'string' && l.email.toLowerCase() === addr && l.campaign === campaignId)
}
