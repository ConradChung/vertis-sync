import 'server-only'
import { INSTANTLY_BASE_URL, InstantlyError } from '@/lib/adapters/instantly'
import { instantlyCall } from '@/lib/adapters/instantlyLeads'

/**
 * Instantly API v2, write side. Only `lib/actions/execute.ts` may import this:
 * every call here sends email, changes a live campaign or creates one, so it
 * runs only after a `pending_actions` row was approved and claimed.
 *
 * Uncached (unlike the read adapter): a status read after a launch must be
 * fresh.
 */

async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const key = process.env.INSTANTLY_API_KEY?.trim()
  if (!key) throw new InstantlyError(0, 'INSTANTLY_API_KEY is not configured')
  let res: Response
  try {
    res = await fetch(`${INSTANTLY_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    throw new InstantlyError(0, `Instantly ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`)
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new InstantlyError(res.status, `Instantly ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`)
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

export interface InstantlyCampaignDetail {
  id?: string
  name?: string
  status?: number
  email_list?: string[]
  campaign_schedule?: unknown
  daily_limit?: number
  sequences?: unknown
  stop_on_reply?: boolean
}

export async function getCampaignDetail(id: string): Promise<InstantlyCampaignDetail> {
  return (await request('GET', `/campaigns/${encodeURIComponent(id)}`)) as InstantlyCampaignDetail
}

export async function pauseCampaign(id: string): Promise<unknown> {
  return request('POST', `/campaigns/${encodeURIComponent(id)}/pause`, {})
}

export async function resumeCampaign(id: string): Promise<unknown> {
  // Instantly v2 resumes a paused campaign with /activate.
  return request('POST', `/campaigns/${encodeURIComponent(id)}/activate`, {})
}

export async function sendReply(input: { eaccount: string; reply_to_uuid: string; subject: string; body: string }): Promise<{ id?: string }> {
  return (await request('POST', '/emails/reply', {
    eaccount: input.eaccount,
    reply_to_uuid: input.reply_to_uuid,
    subject: input.subject,
    body: { text: input.body },
  })) as { id?: string }
}

/** Duplicate: same inboxes, sending window, cap and sequence as the source. */
export async function createCampaignFrom(sourceId: string, name: string): Promise<{ id: string; name: string }> {
  const src = await getCampaignDetail(sourceId)
  const body: Record<string, unknown> = { name }
  if (src.email_list) body.email_list = src.email_list
  if (src.campaign_schedule) body.campaign_schedule = src.campaign_schedule
  if (typeof src.daily_limit === 'number') body.daily_limit = src.daily_limit
  if (src.sequences) body.sequences = src.sequences
  if (typeof src.stop_on_reply === 'boolean') body.stop_on_reply = src.stop_on_reply
  const created = (await request('POST', '/campaigns', body)) as { id?: string }
  if (!created.id) throw new InstantlyError(0, 'Instantly returned no campaign id')
  return { id: created.id, name }
}

/**
 * Delete ONE lead by id (`DELETE /api/v2/leads/{id}`; responses 200 / 404 /
 * 429 per the OpenAPI spec). 429s wait and retry (instantlyCall); a 404 means
 * it is already gone. Any other failure throws InstantlyError. Deliberately
 * per lead: no bulk delete, so every removal is exactly the id that was
 * snapshotted. Only the remove_leads executor calls this. Instantly frees the
 * contact slot 5–10 minutes later.
 */
export async function deleteLead(id: string): Promise<'deleted' | 'not_found'> {
  try {
    await instantlyCall('DELETE', `/leads/${encodeURIComponent(id)}`)
    return 'deleted'
  } catch (err) {
    if (err instanceof InstantlyError && err.status === 404) return 'not_found'
    throw err
  }
}
