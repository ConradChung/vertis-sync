import 'server-only'
import { isInstantlyConfigured } from '@/lib/adapters/instantly'
import { listEmails } from '@/lib/adapters/instantlyEmails'
import type { EventInsert, Json } from '@/lib/db/types'
import { INTEREST, isPositiveWebhook } from '@/lib/inbox/model'
import { notePositiveReply } from '@/lib/inbox/replies'

/**
 * The Instantly webhook's hook into the inbox manager: a positive event
 * (`lead_interested`, or a `reply_received` that carries an interested
 * status) becomes a recorded positive reply + its alert
 * (lib/inbox/replies.ts notePositiveReply). The email id it answers comes
 * from the payload, else from the lead's newest received email (one cached,
 * rate-limited read); without one it is skipped and the list_replies poll
 * picks it up. Never throws: the webhook's answer does not depend on it.
 */

const s = (v: Json | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export async function notePositiveFromWebhook(ev: EventInsert): Promise<void> {
  try {
    const p = (ev.payload ?? {}) as Record<string, Json>
    if (!ev.campaign_id || !ev.lead_email || !isPositiveWebhook(ev.type, p)) return
    let id = s(p.email_id) ?? s(p.reply_to_uuid)
    let eaccount = s(p.email_account) ?? s(p.eaccount)
    if (!id && isInstantlyConfigured()) {
      const page = await listEmails({ campaign_id: ev.campaign_id, lead: ev.lead_email, email_type: 'received', limit: 1 })
      id = page.emails[0]?.id ?? null
      eaccount = eaccount ?? page.emails[0]?.eaccount ?? null
    }
    if (!id) {
      console.error('[inbox/webhook] positive reply without an email id; left for the poll:', ev.webhook_id)
      return
    }
    const ts = s(p.timestamp)
    await notePositiveReply({
      reply_to_uuid: id,
      campaign_id: ev.campaign_id,
      lead_email: ev.lead_email.toLowerCase(),
      eaccount: eaccount ? eaccount.toLowerCase() : null,
      subject: s(p.reply_subject) ?? s(p.subject),
      excerpt: s(p.reply_text) ?? s(p.reply_text_snippet) ?? s(p.text),
      received_at: ts && Number.isFinite(Date.parse(ts)) ? new Date(ts).toISOString() : undefined,
      interest: INTEREST.interested,
      source: 'webhook',
    })
  } catch (err) {
    console.error('[inbox/webhook] positive reply failed:', err instanceof Error ? err.message : err)
  }
}
