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

export const BLOCKLIST_PAGE = 100
export const BLOCKLIST_MAX_PAGES = 5

/**
 * Is the address (or its domain) on the Instantly blocklist? Searches
 * `GET /block-lists-entries?search=` for the address, then the domain,
 * paging through every result (`next_starting_after`) and matching exactly
 * here. If a search still has a full page left after BLOCKLIST_MAX_PAGES, or a
 * full page comes back with no cursor, the answer cannot be proven: it throws
 * `blocklist_unverifiable` (as on any Instantly failure), and callers refuse.
 */
export async function isBlocked(email: string): Promise<boolean> {
  const addr = email.trim().toLowerCase()
  const domain = domainOf(addr)
  for (const term of [addr, domain].filter(Boolean)) {
    let cursor: string | null = null
    for (let page = 0; ; page++) {
      const q = `search=${encodeURIComponent(term)}&limit=${BLOCKLIST_PAGE}${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`
      const body = (await instantlyCall('GET', `/block-lists-entries?${q}`)) as { items?: { bl_value?: unknown }[]; next_starting_after?: unknown }
      const items = body.items ?? []
      for (const it of items) {
        const v = typeof it.bl_value === 'string' ? it.bl_value.trim().toLowerCase() : ''
        if (v && (v === addr || v === domain)) return true
      }
      if (items.length < BLOCKLIST_PAGE) break
      cursor = typeof body.next_starting_after === 'string' && body.next_starting_after ? body.next_starting_after : null
      if (!cursor || page + 1 >= BLOCKLIST_MAX_PAGES) throw new Error(`blocklist_unverifiable: more than ${page + 1} page(s) of matches for ${term}`)
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
