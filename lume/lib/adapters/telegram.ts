import 'server-only'
import type { GateKind, PendingActionRow } from '@/lib/db/types'
import {
  buildActionPrompt,
  buildDecisionNote,
  buildGatePing,
  type InlineKeyboardMarkup,
  type OutgoingMessage,
} from '@/lib/adapters/telegram.messages'

/**
 * Telegram Bot API adapter for Lume's own messages: gate pings with deep
 * links, decision notes, pending-action prompts. The pipelines keep sending
 * their own prompts from the edge functions; this never edits those.
 *
 * Unconfigured (no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, as in local dev):
 * every send logs `[telegram] not configured — skipped: …` and resolves to
 * `{ ok: false, skipped: true }` so callers never 500 over a missing bot.
 *
 * `LUME_URL` unset: the message goes out without its deep link, the adapter
 * logs `[telegram] LUME_URL unset — deep link omitted`, and the result
 * carries `linkOmitted: true`.
 */

export type TelegramResult = (
  | { ok: true; messageId: number | null }
  | { ok: false; skipped: true }
  | { ok: false; skipped?: false; error: string }
) & { linkOmitted?: true }

interface TelegramConfig {
  token: string
  chatId: string
}

function config(): TelegramConfig | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim()
  if (!token || !chatId) return null
  return { token, chatId }
}

function skipped(text: string): TelegramResult {
  console.warn(`[telegram] not configured — skipped: ${text.slice(0, 60)}`)
  return { ok: false, skipped: true }
}

/** The bot token is part of every API URL; never let it reach a log line. */
function redact(message: string, token: string): string {
  return token ? message.split(token).join('<token>') : message
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
      const error = redact(json?.description ?? `HTTP ${res.status}`, cfg.token)
      console.error(`[telegram] ${method} failed: ${error}`)
      return { ok: false, error }
    }
    const messageId = typeof json.result?.message_id === 'number' ? json.result.message_id : null
    return { ok: true, messageId }
  } catch (err) {
    // undici error messages can embed the request URL, token included.
    const error = redact(err instanceof Error ? err.message : String(err), cfg.token)
    console.error(`[telegram] ${method} threw: ${error}`)
    return { ok: false, error }
  }
}

export async function sendMessage(
  text: string,
  opts: { replyMarkup?: InlineKeyboardMarkup; disablePreview?: boolean } = {}
): Promise<TelegramResult> {
  const cfg = config()
  if (!cfg) return skipped(text)
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
  if (!cfg) return skipped(text)
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
