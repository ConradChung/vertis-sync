/**
 * Reply desk Slack messages (pure): the drafted answer posted as a thread
 * reply under the SendPilot notification, with Sent / Redo / Booked / Not
 * interested. The draft and the person's name are plain_text blocks (no
 * mrkdwn), so nothing in them can mention or link anyone.
 */

export const RDESK_ACTION_IDS = {
  sent: 'rdesk_sent',
  redo: 'rdesk_redo',
  booked: 'rdesk_booked',
  not_interested: 'rdesk_not_interested',
} as const
export type RdeskDecision = keyof typeof RDESK_ACTION_IDS
export const RDESK_DECISIONS = Object.keys(RDESK_ACTION_IDS) as RdeskDecision[]

export interface DraftView {
  id: number
  kind: 'reply' | 'followup' | 'checkin'
  step: number | null
  body: string
  name: string | null
}

const plain = (text: string) => ({ type: 'plain_text', text: text.slice(0, 2900), emoji: false })

function title(d: DraftView): string {
  const who = d.name?.trim() || 'this person'
  if (d.kind === 'followup') return `Follow-up ${(d.step ?? 0) + 1} for ${who}. Copy into LinkedIn, then press Sent.`
  if (d.kind === 'checkin') return `Check-in for ${who}. Copy into LinkedIn, then press Sent.`
  return `Draft reply to ${who}. Copy into LinkedIn, then press Sent.`
}

export function draftMessage(d: DraftView): { text: string; blocks: unknown[] } {
  const value = String(d.id)
  return {
    text: d.body.slice(0, 2900),
    blocks: [
      { type: 'context', elements: [plain(title(d))] },
      { type: 'section', text: plain(d.body) },
      {
        type: 'actions',
        block_id: 'rdesk',
        elements: [
          { type: 'button', action_id: RDESK_ACTION_IDS.sent, text: plain('Sent'), style: 'primary', value },
          { type: 'button', action_id: RDESK_ACTION_IDS.redo, text: plain('Redo'), value },
          { type: 'button', action_id: RDESK_ACTION_IDS.booked, text: plain('Booked'), value },
          { type: 'button', action_id: RDESK_ACTION_IDS.not_interested, text: plain('Not interested'), style: 'danger', value },
        ],
      },
    ],
  }
}

const USER = /^[UW][A-Z0-9]{2,30}$/
const OUTCOME: Record<RdeskDecision, string> = {
  sent: 'Sent',
  redo: 'Replaced by a new draft below',
  booked: 'Booked: deal moved to Demo, follow-ups stopped',
  not_interested: 'Not interested: deal closed, follow-ups stopped',
}

/** The draft after a decision: same text, buttons replaced by what happened. */
export function decidedMessage(d: DraftView, decision: RdeskDecision, user: string, note: string | null = null): { text: string; blocks: unknown[] } {
  const by = USER.test(user) ? ` by <@${user}>` : ''
  return {
    text: d.body.slice(0, 2900),
    blocks: [
      { type: 'context', elements: [plain(title(d))] },
      { type: 'section', text: plain(d.body) },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${OUTCOME[decision]}${by}${note ? ` · ${note.replace(/[<>&]/g, '')}` : ''}` }] },
    ],
  }
}

/** A one-line plain-text note in the thread (no buttons), e.g. why no draft was made. */
export function noteMessage(text: string): { text: string; blocks: unknown[] } {
  return { text, blocks: [{ type: 'context', elements: [plain(text)] }] }
}
