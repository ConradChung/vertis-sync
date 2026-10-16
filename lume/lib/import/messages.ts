import type { InlineKeyboardMarkup } from '@/lib/adapters/telegram.messages'

/**
 * The owner prompts for Lume intakes. Pure. Copied from telegram-inbox so the
 * buttons a Lume ingest/order carries are the ones its callback handlers
 * already understand:
 *  - `handleDocument` → `📥 New CSV from …` + approve / approve_enrich / deny
 *    (Deny only when no email column was detected);
 *  - `handleApolloOrPasteText` → `🔗 Apollo search received.` + the
 *    lfo_count presets / lfo_custom / lfo_cancel keyboard.
 */

export const LUME_SENDER_NAME = 'Lume'

export function ingestPromptText(p: { filename: string; rowCount: number; detectedColumn: string | null }): string {
  const columnLine = p.detectedColumn
    ? `Email column: ${p.detectedColumn}`
    : "⚠️ Couldn't confidently detect an email column — you'll need to handle this one via the dashboard."
  return [`📥 New CSV from ${LUME_SENDER_NAME}`, `File: ${p.filename}`, `Rows: ${p.rowCount}`, columnLine].join('\n')
}

export function ingestKeyboard(ingestId: string, detectedColumn: string | null): InlineKeyboardMarkup {
  return detectedColumn
    ? {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve:${ingestId}` },
            { text: '🔎 Approve + Enrich', callback_data: `approve_enrich:${ingestId}` },
            { text: '❌ Deny', callback_data: `deny:${ingestId}` },
          ],
        ],
      }
    : { inline_keyboard: [[{ text: '❌ Deny', callback_data: `deny:${ingestId}` }]] }
}

export const LFO_COUNT_OPTIONS = [500, 1000, 2000, 5000] as const

export const APOLLO_PROMPT_TEXT =
  `🔗 Apollo search received.\n` +
  `How many contacts should Leadsfriday export? Minimum 500; emails are verified. ` +
  `Credits are deducted when the order is placed, and the receipt shows the exact amount and your balance.`

export function lfoCountKeyboard(orderId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      LFO_COUNT_OPTIONS.map((n) => ({ text: String(n), callback_data: `lfo_count:${orderId}:${n}` })),
      [
        { text: '✏️ Custom…', callback_data: `lfo_custom:${orderId}` },
        { text: '❌ Cancel', callback_data: `lfo_cancel:${orderId}` },
      ],
    ],
  }
}

/**
 * `https://app.apollo.io/#/people?<query>` — the whole string, https only, no
 * whitespace, ≤ 4 000 chars. Returns the trimmed URL or `null`.
 * (telegram-inbox finds the same pattern inside free text; Lume takes one URL.)
 */
const APOLLO_PEOPLE_URL = /^https:\/\/app\.apollo\.io\/#\/people\?\S+$/i

export function parseApolloUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const url = raw.trim()
  if (url.length > 4000 || !APOLLO_PEOPLE_URL.test(url)) return null
  return url
}
