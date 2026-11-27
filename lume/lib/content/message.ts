import type { Block } from '@/lib/slack/card'
import { esc } from '@/lib/slack/card'
import { SLOT_LABEL, type Slot, type Variant } from '@/lib/content/slots'

/**
 * The #content-gen message for one draft (pure). Built to copy: the draft is
 * a plain_text section on its own (Slack doesn't reformat plain_text, so what
 * Frank copies is exactly the post), then one context line and the suggested
 * first comment. Redo / Skip only touch Lume's own rows; nothing is posted
 * to LinkedIn, ever.
 */

export const CONTENT_ACTION_IDS = { redo: 'content_redo', skip: 'content_skip' } as const

export interface ContentMessageInput {
  id: number
  slot: Slot
  variant: Variant | null
  formula: string
  body: string
  first_comment: string
  char_count: number
  fact_ids: number[]
  status: string
  decided_by?: string | null
}

export function contextLine(d: ContentMessageInput): string {
  const slot = SLOT_LABEL[d.slot] + (d.variant ? ` (${d.variant})` : '')
  return `${slot} · ${d.formula} · ${d.char_count.toLocaleString('en-US')} chars · facts ${d.fact_ids.map((id) => `#${id}`).join(', ')}`
}

const USER = /^[UW][A-Z0-9]{2,30}$/

export function buildContentMessage(d: ContentMessageInput): { text: string; blocks: Block[] } {
  const blocks: Block[] = [
    { type: 'section', text: { type: 'plain_text', text: d.body, emoji: false } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: esc(contextLine(d)) }] },
    { type: 'section', text: { type: 'plain_text', text: `First comment: ${d.first_comment}`, emoji: false } },
  ]
  const by = d.decided_by && USER.test(d.decided_by) ? ` by <@${d.decided_by}>` : ''
  if (d.status === 'accepted') {
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', action_id: CONTENT_ACTION_IDS.redo, text: { type: 'plain_text', text: 'Redo' }, value: String(d.id) },
        { type: 'button', action_id: CONTENT_ACTION_IDS.skip, text: { type: 'plain_text', text: 'Skip' }, value: String(d.id) },
      ],
    })
  } else if (d.status === 'skipped') {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Skipped${by}.` }] })
  } else if (d.status === 'superseded') {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Redo requested${by}. The new draft follows.` }] })
  } else if (d.status === 'posted') {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Posted on LinkedIn.' }] })
  }
  return { text: d.body, blocks }
}
