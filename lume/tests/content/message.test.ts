import { describe, expect, it } from 'vitest'
import { buildContentMessage, CONTENT_ACTION_IDS, contextLine } from '@/lib/content/message'
import { matchPosts, similarity } from '@/lib/content/match'
import { parseInteraction } from '@/lib/slack/payloads'
import { GOOD_BODY } from './fixtures'

const draft = { id: 42, slot: 'proof' as const, variant: null, formula: 'F7', body: GOOD_BODY, first_comment: 'How it works: kaspen.ai', char_count: 1002, fact_ids: [7, 1], status: 'accepted' }

describe('Slack message shape', () => {
  it('draft as plain text on its own, then context, then first comment, then Redo / Skip', () => {
    const m = buildContentMessage(draft)
    expect(m.text).toBe(GOOD_BODY)
    expect(m.blocks[0]).toEqual({ type: 'section', text: { type: 'plain_text', text: GOOD_BODY, emoji: false } })
    expect(m.blocks[1]).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Proof · F7 · 1,002 chars · facts #7, #1' }] })
    expect(m.blocks[2]).toEqual({ type: 'section', text: { type: 'plain_text', text: 'First comment: How it works: kaspen.ai', emoji: false } })
    expect(m.blocks[3]).toEqual({
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'content_redo', text: { type: 'plain_text', text: 'Redo' }, value: '42' },
        { type: 'button', action_id: 'content_skip', text: { type: 'plain_text', text: 'Skip' }, value: '42' },
      ],
    })
  })

  it('decided drafts lose their buttons and say who decided', () => {
    const skipped = buildContentMessage({ ...draft, status: 'skipped', decided_by: 'U0OWNER' })
    expect(skipped.blocks).toHaveLength(4)
    expect(skipped.blocks[3]).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Skipped by <@U0OWNER>.' }] })
    expect(JSON.stringify(buildContentMessage({ ...draft, status: 'superseded', decided_by: 'U0OWNER' }).blocks[3])).toContain('Redo requested by <@U0OWNER>')
    expect(JSON.stringify(buildContentMessage({ ...draft, status: 'skipped', decided_by: '<!channel>' }).blocks)).not.toContain('<!channel>')
  })

  it('context line names the Hand-raiser variant', () => {
    expect(contextLine({ ...draft, slot: 'hand_raiser', variant: 'breakdown', formula: 'F6' })).toBe('Hand-raiser (breakdown) · F6 · 1,002 chars · facts #7, #1')
  })
})

describe('Slack interaction parsing', () => {
  const form = (payload: unknown) => `payload=${encodeURIComponent(JSON.stringify(payload))}`
  const button = (action_id: string, value?: string) => ({
    type: 'block_actions', team: { id: 'T0AAA' }, user: { id: 'U0USER' }, container: { channel_id: 'C0AAA', message_ts: '1.2' },
    actions: [{ action_id, ...(value ? { value } : {}) }],
  })
  it('maps Redo / Skip to a content_button with the draft id', () => {
    expect(parseInteraction(form(button(CONTENT_ACTION_IDS.redo, '42')))).toEqual({ kind: 'content_button', decision: 'redo', team: 'T0AAA', user: 'U0USER', channel: 'C0AAA', message_ts: '1.2', draft_id: 42 })
    expect(parseInteraction(form(button(CONTENT_ACTION_IDS.skip, '42')))).toMatchObject({ kind: 'content_button', decision: 'skip' })
    expect(parseInteraction(form(button(CONTENT_ACTION_IDS.skip, 'x')))).toBeNull()
  })
})

describe('post matching', () => {
  it('matches a lightly edited post, not an unrelated one', () => {
    expect(similarity(GOOD_BODY, GOOD_BODY)).toBe(1)
    const edited = GOOD_BODY.slice(0, 500).replace('hiring faster', 'hiring fast').replace('another late night', 'one more late night')
    expect(similarity(GOOD_BODY.slice(0, 500), edited)).toBeGreaterThan(0.6)
    expect(similarity(GOOD_BODY, 'Huge congrats to the team on our new office opening this week, grateful for everyone.')).toBeLessThan(0.1)
  })

  it('each post and draft is used once, and a post must come after its draft', () => {
    const drafts = [{ id: 1, body: GOOD_BODY, created_at: '2026-12-01T14:30:00Z' }]
    const posts = [
      { post_id: 'a', text_excerpt: GOOD_BODY.slice(0, 500), posted_at: '2026-12-01T16:00:00Z' },
      { post_id: 'b', text_excerpt: GOOD_BODY.slice(0, 480), posted_at: '2026-12-02T16:00:00Z' },
      { post_id: 'old', text_excerpt: GOOD_BODY.slice(0, 500), posted_at: '2026-11-01T16:00:00Z' },
    ]
    const m = matchPosts(posts, drafts)
    expect(m).toHaveLength(1)
    expect(['a', 'b']).toContain(m[0].post_id)
    expect(matchPosts([posts[2]], drafts)).toEqual([])
  })
})
