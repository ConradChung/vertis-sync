import { configuredBaseUrl } from '@/lib/http/origin'
import type { GateKind, PendingActionRow } from '@/lib/db/types'

/**
 * Pure message builders for the Telegram adapter (no `server-only`, so they
 * are unit-tested). `lib/adapters/telegram.ts` sends what these return.
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
}

/** `${LUME_URL}/validate?gate=<kind>:<id>` — the Validate screen scrolls to the gate. */
export const deepLink = (kind: GateKind | string, id: string): string =>
  `${configuredBaseUrl()}/validate?gate=${kind}:${id}`

/** `${LUME_URL}/actions/<id>` — the pending-action confirm page. */
export const actionLink = (id: string): string => `${configuredBaseUrl()}/actions/${id}`

/** Second, short message after the pipeline's own prompt: a link into Lume. */
export function buildGatePing(kind: GateKind | string, targetId: string, title?: string | null): OutgoingMessage {
  const label = title?.trim() || kind
  return {
    text: `🔗 ${label} — open in Lume\n${deepLink(kind, targetId)}`,
    disablePreview: true,
  }
}

/** Approval prompt for a `pending_actions` row: summary, lume_ok/lume_no buttons, deep link. */
export function buildActionPrompt(action: PendingActionRow): OutgoingMessage {
  const summary = typeof action.payload?.summary === 'string' && action.payload.summary.trim()
    ? action.payload.summary.trim()
    : action.kind
  const lines = [`🛡 ${action.kind}`, summary, '', `Review in Lume: ${actionLink(action.id)}`]
  return {
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
}

/** Same wording telegram-inbox uses after a Lume-originated action. */
export function buildDecisionNote(action: string, targetId: string): string {
  return `🖥 ${action} on ${targetId.slice(0, 8)} — decided in Lume`
}
