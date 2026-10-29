/**
 * The client channel's post for one positive reply (3g): a lead card, the
 * drafted reply, and the Approve / Edit / Skip buttons when, and only when,
 * the campaign is in Client mode and the reply is not a possible opt-out.
 * Pure: facts in, Slack Block Kit out. chat.postMessage builds the first
 * version; chat.update rebuilds it on every change (draft, decision, send).
 *
 * Rules (owner decisions, 2026-10-29):
 *  - Only the fields the owner made visible for the channel are shown; a
 *    visible field with no value reads "missing", never a guess.
 *  - The lead's words and every fact are untrusted: escaped for mrkdwn, so a
 *    reply cannot @channel, link-spoof or format the post.
 *  - Owner mode: no buttons, "Awaiting Conrad". Auto mode: no buttons, Lume
 *    sends after its safety checks. Possible opt-out / hostile: no buttons,
 *    ever, whatever the mode.
 */

export const CARD_FIELDS = ['name', 'title', 'company', 'website', 'phone', 'linkedin', 'location', 'reply', 'stage'] as const
export type CardField = (typeof CARD_FIELDS)[number]

export const FIELD_LABEL: Record<CardField, string> = {
  name: 'Name',
  title: 'Title',
  company: 'Company',
  website: 'Website',
  phone: 'Phone',
  linkedin: 'LinkedIn',
  location: 'Location',
  reply: 'Their reply',
  stage: 'CRM stage',
}

export const parseVisibleFields = (v: unknown): CardField[] =>
  Array.isArray(v) ? CARD_FIELDS.filter((f) => v.includes(f)) : [...CARD_FIELDS]

/** What the card is built from. Null = not known; shown as missing. */
export type LeadFacts = Record<CardField, string | null>

export const OWNER_NAME = 'Conrad'

export const ACTION_IDS = { approve: 'lume_approve', edit: 'lume_edit', skip: 'lume_skip' } as const
export const EDIT_CALLBACK_ID = 'lume_edit_submit'
export const EDIT_BLOCK_ID = 'lume_body'
export const EDIT_INPUT_ID = 'body'

export type CardMode = 'owner' | 'client' | 'auto'

export type DraftState =
  | { kind: 'none' }
  | {
      kind: 'action'
      action_id: string
      status: 'awaiting' | 'approved' | 'executing' | 'executed' | 'rejected' | 'failed' | 'expired'
      body: string
      decided_via: string | null
      decided_by_slack_user: string | null
      edited_by_slack_user: string | null
      error_code: string | null
    }

export interface CardInput {
  facts: LeadFacts
  visible: readonly CardField[]
  mode: CardMode
  /** The lead may have asked to stop or was hostile: never offer Approve. */
  optOut: boolean
  draft: DraftState
}

/** Escape for Slack mrkdwn (&, <, >): untrusted text never links or mentions. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** A Slack user mention, only for a well-formed id (never untrusted text). */
export const mention = (id: string | null | undefined) => (id && /^[UW][A-Z0-9]{2,30}$/.test(id) ? `<@${id}>` : 'a client user')

function fieldText(f: CardField, v: string | null): string {
  if (!v || !v.trim()) return `*${FIELD_LABEL[f]}:* _missing_`
  const value = f === 'reply' ? `>${esc(clip(v.trim(), 1500)).replace(/\n/g, '\n>')}` : esc(clip(oneLine(v), 300))
  return f === 'reply' ? `*${FIELD_LABEL[f]}:*\n${value}` : `*${FIELD_LABEL[f]}:* ${value}`
}

/** One-line plain fallback (notifications, screen readers). Name and company only. */
export function fallbackText(facts: LeadFacts, visible: readonly CardField[]): string {
  const name = visible.includes('name') && facts.name ? oneLine(facts.name) : null
  const company = visible.includes('company') && facts.company ? oneLine(facts.company) : null
  const who = name ? `${name}${company ? ` (${company})` : ''}` : company ? `a lead at ${company}` : 'a lead'
  return esc(clip(`New positive reply from ${who}`, 200))
}

/** The status line under the draft, for every state. */
export function statusLine(c: CardInput): string {
  const d = c.draft
  if (d.kind === 'none') return c.optOut ? `:warning: This may be an opt-out or a hostile reply. ${OWNER_NAME} handles it; no reply will be offered here.` : '_Drafting a reply…_'
  const by = d.decided_via === 'client' ? mention(d.decided_by_slack_user) : d.decided_via === 'grant' ? 'Auto mode' : OWNER_NAME
  switch (d.status) {
    case 'awaiting':
      if (c.optOut) return `:warning: This may be an opt-out or a hostile reply. ${OWNER_NAME} handles it.`
      if (c.mode === 'owner') return `:hourglass_flowing_sand: Awaiting ${OWNER_NAME}'s approval.`
      if (c.mode === 'auto') return ':robot_face: Auto mode: Lume sends this after its safety checks.'
      return d.edited_by_slack_user
        ? `:pencil2: Edited by ${mention(d.edited_by_slack_user)}. A second approval is needed (${OWNER_NAME} or another teammate).`
        : ':raised_hand: Awaiting approval. Approve sends it after Lume re-checks the live thread.'
    case 'approved':
    case 'executing':
      return `:white_check_mark: Approved by ${by}. Sending after the live thread re-check…`
    case 'executed':
      return `:white_check_mark: Sent (approved by ${by}).`
    case 'failed':
      return `:warning: Not sent${d.error_code ? ` (${esc(d.error_code)})` : ''}. ${OWNER_NAME} will look at it.`
    case 'rejected':
      return `:no_entry_sign: Skipped by ${by}. Nothing was sent.`
    case 'expired':
      return ':hourglass: Expired. Nothing was sent.'
  }
}

/** Buttons appear only for an awaiting draft, in Client mode, never on a possible opt-out. */
export function showButtons(c: CardInput): boolean {
  return c.draft.kind === 'action' && c.draft.status === 'awaiting' && c.mode === 'client' && !c.optOut
}

// Block Kit is plain JSON; kept loose on purpose.
export type Block = Record<string, unknown>

export function buildCard(c: CardInput): { text: string; blocks: Block[] } {
  const visible = c.visible.length ? c.visible : []
  const blocks: Block[] = [{ type: 'header', text: { type: 'plain_text', text: 'New positive reply', emoji: true } }]
  const short = visible.filter((f) => f !== 'reply')
  for (let i = 0; i < short.length; i += 10) {
    blocks.push({ type: 'section', fields: short.slice(i, i + 10).map((f) => ({ type: 'mrkdwn', text: fieldText(f, c.facts[f]) })) })
  }
  if (visible.includes('reply')) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: fieldText('reply', c.facts.reply) } })
  blocks.push({ type: 'divider' })
  if (c.draft.kind === 'action' && !c.optOut) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Drafted reply:*\n>${esc(clip(c.draft.body.trim(), 2800)).replace(/\n/g, '\n>')}` } })
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statusLine(c) }] })
  if (showButtons(c) && c.draft.kind === 'action') {
    const id = c.draft.action_id
    blocks.push({
      type: 'actions',
      block_id: 'lume_decide',
      elements: [
        {
          type: 'button', action_id: ACTION_IDS.approve, style: 'primary', value: id, text: { type: 'plain_text', text: 'Approve' },
          confirm: {
            title: { type: 'plain_text', text: 'Send this reply?' },
            text: { type: 'mrkdwn', text: 'Lume re-checks the live thread first and sends nothing if anything changed.' },
            confirm: { type: 'plain_text', text: 'Approve' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
        { type: 'button', action_id: ACTION_IDS.edit, value: id, text: { type: 'plain_text', text: 'Edit' } },
        { type: 'button', action_id: ACTION_IDS.skip, style: 'danger', value: id, text: { type: 'plain_text', text: 'Skip' } },
      ],
    })
  }
  return { text: fallbackText(c.facts, visible), blocks }
}

/** The Edit modal (views.open). private_metadata carries the post id only. */
export function buildEditModal(postId: number, body: string): Block {
  return {
    type: 'modal',
    callback_id: EDIT_CALLBACK_ID,
    private_metadata: String(postId),
    title: { type: 'plain_text', text: 'Edit reply' },
    submit: { type: 'plain_text', text: 'Save edit' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: EDIT_BLOCK_ID,
        label: { type: 'plain_text', text: 'Reply' },
        element: { type: 'plain_text_input', action_id: EDIT_INPUT_ID, multiline: true, max_length: 3000, initial_value: clip(body, 3000) },
        hint: { type: 'plain_text', text: 'Saving does not send. Someone other than you approves the edited reply.' },
      },
    ],
  }
}
