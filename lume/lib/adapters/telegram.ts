import 'server-only'
import type { GateKind, PendingActionRow } from '@/lib/db/types'
import {
  buildActionPrompt,
  buildDecisionNote,
  buildGatePing,
  type InlineKeyboardMarkup,
  type OutgoingMessage,
} from '@/lib/adapters/telegram.messages'
import { MISSING_CHAT_ID, MISSING_TOKEN, type TelegramSkipReason } from '@/lib/adapters/telegram.notify'

export { CHANNEL_DISABLED, MISSING_CHAT_ID, MISSING_TOKEN, type TelegramSkipReason } from '@/lib/adapters/telegram.notify'

/**
 * Telegram Bot API adapter for Lume's own messages: gate pings with deep
 * links, decision notes, pending-action prompts. The pipelines keep sending
 * their own prompts from the edge functions; this never edits those.
 *
 * Unconfigured (no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, as in local dev):
 * every send logs `[telegram] not configured — skipped: …` and resolves to
 * `{ ok: false, skipped: true, reason }` ("missing token" / "missing chat id")
 * so callers never 500 over a missing bot and can record why.
 *
 * API errors and exceptions resolve to `{ ok: false, error }`, where `error`
 * is short and token-free ("Telegram 401: Unauthorized",
 * "Telegram request failed: …"); lib/adapters/telegram.notify.ts maps either
 * onto a pending action's notify_status / notify_error.
 *
 * `LUME_URL` unset: the message goes out without its deep link, the adapter
 * logs `[telegram] LUME_URL unset — deep link omitted`, and the result
 * carries `linkOmitted: true`.
 */

export type TelegramResult = (
  | { ok: true; messageId: number | null }
  | { ok: false; skipped: true; reason: TelegramSkipReason }
  | { ok: false; skipped?: false; error: string }
) & { linkOmitted?: true }

interface TelegramConfig {
  token: string
  chatId: string
}

function config(): TelegramConfig | TelegramSkipReason {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim()
  if (!token) return MISSING_TOKEN
  if (!chatId) return MISSING_CHAT_ID
  return { token, chatId }
}

function skipped(text: string, reason: TelegramSkipReason): TelegramResult {
  console.warn(`[telegram] not configured — skipped: ${text.slice(0, 60)}`)
  return { ok: false, skipped: true, reason }
}

/**
 * The bot token is part of every API URL; never let it reach a log line or a
 * stored error. The token itself becomes `<token>`, and any Telegram API URL
 * (which would carry it) is dropped as a whole.
 */
export function redact(message: string, token: string): string {
  const noToken = token ? message.split(token).join('<token>') : message
  return noToken.replace(/https?:\/\/api\.telegram\.org\/\S*/g, '<telegram api>')
}

async function call(cfg: TelegramConfig, method: string, body: Record<string, unknown>): Promise<TelegramResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; result?: { message_id?: number }; description?: string }
      | null
    if (!res.ok || !json?.ok) {
      const status = res.ok ? (json ? 'error' : 'bad response') : String(res.status)
      const error = redact(`Telegram ${status}: ${json?.description ?? `HTTP ${res.status}`}`, cfg.token)
      console.error(`[telegram] ${method} failed: ${error}`)
      return { ok: false, error }
    }
    const messageId = typeof json.result?.message_id === 'number' ? json.result.message_id : null
    return { ok: true, messageId }
  } catch (err) {
    // undici error messages can embed the request URL, token included.
    const error = redact(`Telegram request failed: ${err instanceof Error ? err.message : String(err)}`, cfg.token)
    console.error(`[telegram] ${method} threw: ${error}`)
    return { ok: false, error }
  }
}

export async function sendMessage(
  text: string,
  opts: { replyMarkup?: InlineKeyboardMarkup; disablePreview?: boolean } = {}
): Promise<TelegramResult> {
  const cfg = config()
  if (typeof cfg === 'string') return skipped(text, cfg)
  return call(cfg, 'sendMessage', {
    chat_id: cfg.chatId,
    text,
    ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
    ...(opts.disablePreview ? { link_preview_options: { is_disabled: true } } : {}),
  })
}

export async function editMessage(
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup
): Promise<TelegramResult> {
  const cfg = config()
  if (typeof cfg === 'string') return skipped(text, cfg)
  return call(cfg, 'editMessageText', {
    chat_id: cfg.chatId,
    message_id: messageId,
    text,
    // An omitted reply_markup leaves the keyboard; an empty one clears it.
    reply_markup: replyMarkup ?? { inline_keyboard: [] },
  })
}

async function send(m: OutgoingMessage): Promise<TelegramResult> {
  if (m.linkOmitted) console.warn('[telegram] LUME_URL unset — deep link omitted')
  const result = await sendMessage(m.text, { replyMarkup: m.replyMarkup, disablePreview: m.disablePreview })
  return m.linkOmitted ? { ...result, linkOmitted: true } : result
}

/** `🔗 <title or kind> — open in Lume` + deep link. */
export function sendGatePing(kind: GateKind | string, targetId: string, title?: string | null): Promise<TelegramResult> {
  return send(buildGatePing(kind, targetId, title))
}

/** `🖥 <action> on <id8> — decided in Lume`. */
export function sendDecisionNote(action: string, targetId: string): Promise<TelegramResult> {
  return sendMessage(buildDecisionNote(action, targetId))
}

/** Approval prompt with the lume_ok / lume_no keyboard and the /actions/<id> link. */
export function sendActionPrompt(action: PendingActionRow): Promise<TelegramResult> {
  return send(buildActionPrompt(action))
}
