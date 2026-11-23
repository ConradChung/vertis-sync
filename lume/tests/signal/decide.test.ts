import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ getSignalConfig: vi.fn(), getSignalPerson: vi.fn(), getSignalPost: vi.fn(), decideSignalPerson: vi.fn() }))
vi.mock('@/lib/signal/store', () => store)
const api = vi.hoisted(() => ({ slackApi: vi.fn() }))
vi.mock('@/lib/slack/api', () => api)
const slackStore = vi.hoisted(() => ({ getBotToken: vi.fn() }))
vi.mock('@/lib/slack/store', () => slackStore)

import { parseSignalConfig } from '@/lib/signal/config'
import { buildSignalEditModal } from '@/lib/slack/signalCard'
import { parseInteraction } from '@/lib/slack/payloads'
import { signalButton, signalOpenEdit, signalSaveEdit } from '@/lib/slack/signalDecide'
import { person } from './fixtures'

const TEAM = 'T082MHH6U5P'
const actor = { team: TEAM, user: 'U0SALES', channel: 'C0SALES' }
const posted = (over = {}) => ({ ...person({ alert_status: 'posted' }), slack_team_id: TEAM, slack_channel_id: 'C0SALES', slack_ts: '1700.0001', ...over })
const calls = (m: string) => api.slackApi.mock.calls.filter((c) => c[0] === m)

beforeEach(() => {
  vi.resetAllMocks()
  store.getSignalConfig.mockResolvedValue(parseSignalConfig({ dry_run: false, slack: { team_id: TEAM, channel_id: 'C0SALES', channel_name: 'sales' } }))
  store.getSignalPerson.mockResolvedValue(posted())
  store.getSignalPost.mockResolvedValue({ post_id: '7400', post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7400', posted_at: '2026-11-20T00:00:00Z', text_excerpt: null })
  slackStore.getBotToken.mockResolvedValue({ token: 'xoxb-test', bot_user_id: 'U0BOT' })
  api.slackApi.mockResolvedValue({ ok: true })
})

describe('signalButton', () => {
  it('approve: conditional update, then chat.update to the approved render with drafts visible', async () => {
    store.decideSignalPerson.mockResolvedValue(posted({ alert_status: 'approved', decided_by: 'U0SALES' }))
    expect(await signalButton(actor, '1700.0001', 42, 'approve')).toBe('done')
    expect(store.decideSignalPerson).toHaveBeenCalledWith(42, ['posted', 'edited'], { alert_status: 'approved', decided_by: 'U0SALES' })
    const [, , body] = calls('chat.update')[0]
    expect(body).toMatchObject({ channel: 'C0SALES', ts: '1700.0001' })
    const s = JSON.stringify(body.blocks)
    expect(s).toContain('Approved by <@U0SALES>')
    expect(s).toContain('```Hi Ada, thanks for the comment.```')
    expect(s).not.toContain('signal_approve')
  })

  it('skip collapses the card', async () => {
    store.decideSignalPerson.mockResolvedValue(posted({ alert_status: 'skipped', decided_by: 'U0SALES' }))
    await signalButton(actor, '1700.0001', 42, 'skip')
    expect(store.decideSignalPerson).toHaveBeenCalledWith(42, ['posted', 'edited'], expect.objectContaining({ alert_status: 'skipped' }))
    const blocks = calls('chat.update')[0][2].blocks
    expect(blocks).toHaveLength(2)
    expect(JSON.stringify(blocks)).toContain('Skipped by <@U0SALES>')
  })

  it('a double click finds nothing to claim and only re-renders the current state', async () => {
    store.decideSignalPerson.mockResolvedValue(null)
    store.getSignalPerson.mockResolvedValueOnce(posted()).mockResolvedValueOnce(posted({ alert_status: 'approved', decided_by: 'U0OTHER' }))
    expect(await signalButton(actor, '1700.0001', 42, 'approve')).toBe('already')
    expect(JSON.stringify(calls('chat.update')[0][2].blocks)).toContain('Approved by <@U0OTHER>')
  })

  it('refuses a click from another workspace or channel, or on a stale message', async () => {
    expect(await signalButton({ ...actor, channel: 'C0OTHER' }, '1700.0001', 42, 'approve')).toBe('refused')
    expect(await signalButton({ ...actor, team: 'T0OTHER1' }, '1700.0001', 42, 'approve')).toBe('refused')
    expect(await signalButton(actor, '1700.9999', 42, 'approve')).toBe('refused')
    store.getSignalPerson.mockResolvedValue(posted({ kind: 'reactor' }))
    expect(await signalButton(actor, '1700.0001', 42, 'approve')).toBe('refused')
    expect(store.decideSignalPerson).not.toHaveBeenCalled()
    expect(calls('chat.update')).toHaveLength(0)
  })
})

describe('edit round trip', () => {
  it('opens the modal, parses its submission, saves the drafts as edited and updates the card', async () => {
    expect(await signalOpenEdit(actor, '1700.0001', 42, 'trig-1')).toBe('opened')
    const [, , { trigger_id, view }] = calls('views.open')[0]
    expect(trigger_id).toBe('trig-1')
    expect(view).toEqual(buildSignalEditModal(posted(), 200))

    // Slack echoes the modal's blocks back as state.values on submit.
    const values: Record<string, Record<string, { type: string; value: string | null }>> = {}
    for (const b of view.blocks as { block_id: string; element: { initial_value?: string } }[]) values[b.block_id] = { value: { type: 'plain_text_input', value: b.element.initial_value ?? null } }
    values.signal_dm.value.value = 'Hi Ada, edited DM.'
    values.signal_no_note_followup.value.value = null
    const payload = { type: 'view_submission', team: { id: TEAM }, user: { id: 'U0SALES' }, view: { callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values } } }
    const it = parseInteraction(`payload=${encodeURIComponent(JSON.stringify(payload))}`)
    expect(it).toMatchObject({ kind: 'signal_edit_submit', team: TEAM, user: 'U0SALES', person_id: 42 })
    if (it?.kind !== 'signal_edit_submit') throw new Error('not parsed')

    const saved = { opening: 'Hi Ada', dm: 'Hi Ada, edited DM.', connection_note: 'Hi Ada, saw your comment on my post.', followup_dm: 'Thanks for connecting!', no_note_followup: null }
    store.decideSignalPerson.mockResolvedValue(posted({ alert_status: 'edited', decided_by: 'U0SALES', drafts: saved }))
    expect(await signalSaveEdit({ team: it.team, user: it.user }, it.person_id, it.drafts)).toBe('saved')
    expect(store.decideSignalPerson).toHaveBeenCalledWith(42, ['posted', 'edited'], { alert_status: 'edited', decided_by: 'U0SALES', drafts: saved })
    const s = JSON.stringify(calls('chat.update')[0][2].blocks)
    expect(s).toContain('```Hi Ada, edited DM.```')
    expect(s).toContain('edited by <@U0SALES>')
    expect(s).toContain('signal_approve')
  })

  it('will not open the editor on a decided card', async () => {
    store.getSignalPerson.mockResolvedValue(posted({ alert_status: 'approved' }))
    expect(await signalOpenEdit(actor, '1700.0001', 42, 'trig-1')).toBe('refused')
    expect(calls('views.open')).toHaveLength(0)
    expect(calls('chat.postEphemeral')).toHaveLength(1)
  })
})
