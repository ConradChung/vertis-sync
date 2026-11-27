import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseContentConfig } from '@/lib/content/config'
import { GOOD_BODY } from './fixtures'

const h = vi.hoisted(() => ({
  slackApi: vi.fn(),
  getBotToken: vi.fn(),
  getDraft: vi.fn(),
  decideDraft: vi.fn(),
  getContentConfig: vi.fn(),
  generateDraft: vi.fn(),
}))
vi.mock('@/lib/slack/api', () => ({ slackApi: h.slackApi }))
vi.mock('@/lib/slack/store', () => ({ getBotToken: h.getBotToken }))
vi.mock('@/lib/content/store', () => ({ getDraft: h.getDraft, decideDraft: h.decideDraft }))
vi.mock('@/lib/content/live', () => ({ getContentConfig: h.getContentConfig, liveDeps: () => ({}) }))
vi.mock('@/lib/content/engine', () => ({ generateDraft: h.generateDraft }))

const { contentButton } = await import('@/lib/content/decide')

const actor = { team: 'T082MHH6U5P', user: 'U0OWNER', channel: 'C0CONTENT1' }
const row = (over = {}) => ({
  id: 5, slot: 'owner_view', variant: null, status: 'accepted', formula: 'F10', body: GOOD_BODY, first_comment: 'c', char_count: 1002, fact_ids: [10, 1],
  slack_team_id: actor.team, slack_channel_id: actor.channel, slack_ts: '1.2', decided_by: null, ...over,
})

beforeEach(() => {
  vi.resetAllMocks()
  h.getBotToken.mockResolvedValue({ token: 'xoxb-test', bot_user_id: 'B1' })
  h.getContentConfig.mockResolvedValue(parseContentConfig({ dry_run: false, slack: { team_id: actor.team, channel_id: actor.channel } }))
  h.slackApi.mockResolvedValue({ ok: true })
})

describe('Redo / Skip', () => {
  it('Skip records the decision and re-renders without buttons; no new draft', async () => {
    h.getDraft.mockResolvedValue(row())
    h.decideDraft.mockResolvedValue(row({ status: 'skipped', decided_by: 'U0OWNER' }))
    expect(await contentButton(actor, '1.2', 5, 'skip')).toBe('done')
    expect(h.decideDraft).toHaveBeenCalledWith(5, 'skipped', 'U0OWNER')
    const update = h.slackApi.mock.calls.find((c) => c[0] === 'chat.update')!
    expect(JSON.stringify(update[2].blocks)).toContain('Skipped by <@U0OWNER>')
    expect(h.generateDraft).not.toHaveBeenCalled()
  })

  it('Redo supersedes the draft and writes a new one for the same slot', async () => {
    h.getDraft.mockResolvedValue(row())
    h.decideDraft.mockResolvedValue(row({ status: 'superseded', decided_by: 'U0OWNER' }))
    h.generateDraft.mockResolvedValue({ status: 'accepted', slack: 'posted' })
    expect(await contentButton(actor, '1.2', 5, 'redo')).toBe('done')
    expect(h.decideDraft).toHaveBeenCalledWith(5, 'superseded', 'U0OWNER')
    expect(h.generateDraft.mock.calls[0][0]).toMatchObject({ slot: 'owner_view', variant: null, trigger: 'redo', redoOf: 5 })
  })

  it('refuses clicks from another channel or on a stale message', async () => {
    h.getDraft.mockResolvedValue(row())
    expect(await contentButton({ ...actor, channel: 'C0OTHER1' }, '1.2', 5, 'skip')).toBe('refused')
    expect(await contentButton(actor, '9.9', 5, 'skip')).toBe('refused')
    expect(h.decideDraft).not.toHaveBeenCalled()
  })

  it('a double click decides once', async () => {
    h.getDraft.mockResolvedValue(row({ status: 'skipped' }))
    h.decideDraft.mockResolvedValue(null)
    expect(await contentButton(actor, '1.2', 5, 'redo')).toBe('already')
    expect(h.generateDraft).not.toHaveBeenCalled()
  })
})
