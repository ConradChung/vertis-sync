import { configuredBaseUrl } from '@/lib/http/origin'
import type { GateKind, PendingActionRow } from '@/lib/db/types'

/**
 * Pure message builders for the Telegram adapter (no `server-only`, so they
 * are unit-tested). `lib/adapters/telegram.ts` sends what these return.
 *
 * Deep links need `LUME_URL`. When it is unset the builders return the
 * message without a link and set `linkOmitted`; the adapter logs it. A ping
 * with no link is still worth sending — the pipeline's own prompt already
 * carries the buttons, this one just says "there is a gate".
 */

export interface InlineKeyboardButton {
  text: string
  callback_data: string
}
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

export interface OutgoingMessage {
  text: string
  replyMarkup?: InlineKeyboardMarkup
  disablePreview?: boolean
  /** True when `LUME_URL` was unset and the deep link was left out. */
  linkOmitted?: true
}

/** `${LUME_URL}/validate?gate=<kind>:<id>`; `null` when `LUME_URL` is unset. */
export function deepLink(kind: GateKind | string, id: string): string | null {
  const base = configuredBaseUrl()
  return base ? `${base}/validate?gate=${kind}:${id}` : null
}

/** `${LUME_URL}/actions/<id>`; `null` when `LUME_URL` is unset. */
export function actionLink(id: string): string | null {
  const base = configuredBaseUrl()
  return base ? `${base}/actions/${id}` : null
}

/** Second, short message after the pipeline's own prompt: a link into Lume. */
export function buildGatePing(kind: GateKind | string, targetId: string, title?: string | null): OutgoingMessage {
  const label = title?.trim() || kind
  const link = deepLink(kind, targetId)
  const head = `🔗 ${label} — open in Lume`
  return link
    ? { text: `${head}\n${link}`, disablePreview: true }
    : { text: head, disablePreview: true, linkOmitted: true }
}

/** Telegram caps a message at 4096 chars; this leaves room for the summary and link. */
export const REPLY_BODY_MAX = 3500

/** What a send_reply approval actually sends: recipient, sender, subject, the full body. */
function replyDetail(p: Record<string, unknown>): string[] {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const lead = text(p.lead_email)
  const to = lead ? (p.recipient_verified === false ? `${lead} (unverified)` : lead) : 'unverified — check in Lume'
  const body = text(p.body) ?? ''
  const clipped = body.length > REPLY_BODY_MAX ? `${body.slice(0, REPLY_BODY_MAX)}… [truncated, full text in Lume]` : body
  const out = [`To: ${to}`]
  if (text(p.eaccount)) out.push(`From: ${text(p.eaccount)}`)
  if (text(p.subject)) out.push(`Subject: ${text(p.subject)}`)
  out.push('', clipped)
  return out
}

/** Approval prompt for a `pending_actions` row: summary, lume_ok/lume_no buttons, deep link. */
export function buildActionPrompt(action: PendingActionRow): OutgoingMessage {
  const summary = typeof action.payload?.summary === 'string' && action.payload.summary.trim()
    ? action.payload.summary.trim()
    : action.kind
  const link = actionLink(action.id)
  const lines = [`🛡 ${action.kind}`, summary]
  if (action.kind === 'send_reply') lines.push('', ...replyDetail(action.payload ?? {}))
  if (link) lines.push('', `Review in Lume: ${link}`)
  const message: OutgoingMessage = {
    text: lines.join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `lume_ok:${action.id}` },
          { text: '❌ Reject', callback_data: `lume_no:${action.id}` },
        ],
      ],
    },
    disablePreview: true,
  }
  if (!link) message.linkOmitted = true
  return message
}

/** Same wording telegram-inbox uses after a Lume-originated action. */
export function buildDecisionNote(action: string, targetId: string): string {
  return `🖥 ${action} on ${targetId.slice(0, 8)} — decided in Lume`
}
