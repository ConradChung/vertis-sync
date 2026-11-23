import type { TelegramResult } from '@/lib/adapters/telegram'

/**
 * Why a Telegram prompt went out or not, as stored on `pending_actions`
 * (`notify_status` / `notify_error` / `notified_at`). Pure: no env, no I/O.
 *
 * For three weeks no approval prompt was sent and nothing said so (the bot
 * was unset in production and the skip only logged). Every prompt attempt now
 * leaves one of these on its row, so the card can show it.
 */

export const MISSING_TOKEN = 'missing token'
export const MISSING_CHAT_ID = 'missing chat id'
/** lib/alerts.ts: ALERT_CHANNELS has no `telegram`, so the send never ran. */
export const CHANNEL_DISABLED = 'telegram channel disabled (ALERT_CHANNELS)'

export type TelegramSkipReason = typeof MISSING_TOKEN | typeof MISSING_CHAT_ID | typeof CHANNEL_DISABLED

export type NotifyStatus = 'sent' | 'skipped' | 'failed'

export interface NotifyOutcome {
  status: NotifyStatus
  /** Short, token-free reason; null when sent. */
  error: string | null
}

/** The DB check on notify_error. */
export const NOTIFY_ERROR_MAX = 300

export const clipNotifyError = (s: string): string => (s.length > NOTIFY_ERROR_MAX ? `${s.slice(0, NOTIFY_ERROR_MAX - 1)}…` : s)

/**
 * The adapter's result → the row's outcome. `undefined` / `null` is what
 * `alert()` returns when the telegram channel is switched off.
 */
export function notifyOutcome(r: TelegramResult | undefined | null): NotifyOutcome {
  if (!r) return { status: 'skipped', error: CHANNEL_DISABLED }
  if (r.ok) return { status: 'sent', error: null }
  if (r.skipped) return { status: 'skipped', error: clipNotifyError(r.reason || 'not configured') }
  return { status: 'failed', error: clipNotifyError(r.error || 'unknown error') }
}

export interface NotifyPatch {
  notify_status: NotifyStatus
  notify_error: string | null
  notified_at: string | null
}

/** The columns written for an outcome: `notified_at` only when it was sent. */
export function notifyPatch(o: NotifyOutcome, now: Date = new Date()): NotifyPatch {
  return {
    notify_status: o.status,
    notify_error: o.status === 'sent' ? null : o.error == null ? null : clipNotifyError(o.error),
    notified_at: o.status === 'sent' ? now.toISOString() : null,
  }
}
