import { beforeEach, describe, expect, it, vi } from 'vitest'

// An in-memory signal_reddit_mentions with the real store's conditional semantics.
type Row = Record<string, unknown> & { id: number; permalink: string; alert_status: string | null; slack_ts: string | null; hot: boolean }
const db = vi.hoisted(() => ({ rows: [] as Row[] }))
vi.mock('@/lib/reddit/store', () => ({
  existingKeys: async (keys: string[]) => new Set(db.rows.filter((r) => keys.includes(r.permalink)).map((r) => r.permalink)),
  insertMention: async (m: Record<string, unknown>) => {
    if (db.rows.some((r) => r.permalink === m.permalink)) return false
    db.rows.push({ ...m, id: db.rows.length + 1, alert_status: null, slack_ts: null, decided_by: null } as unknown as Row)
    return true
  },
  listUnalerted: async () => db.rows.filter((r) => r.alert_status === null).sort((a, b) => Number(b.hot) - Number(a.hot) || a.id - b.id),
  claimMention: async (id: number, status: string, card: unknown) => {
    const r = db.rows.find((x) => x.id === id && x.alert_status === null)
    if (!r) return false
    Object.assign(r, { alert_status: status, card })
    return true
  },
  markMentionPosted: async (id: number, p: { ts: string; team: string; channel: string }) => {
    const r = db.rows.find((x) => x.id === id && x.alert_status === 'posted')
    if (r) Object.assign(r, { slack_ts: p.ts, slack_team_id: p.team, slack_channel_id: p.channel })
  },
  releaseMention: async (id: number) => {
    const r = db.rows.find((x) => x.id === id && x.alert_status === 'posted' && !x.slack_ts)
    if (r) r.alert_status = null
  },
}))
const signalStore = vi.hoisted(() => ({ getSignalConfig: vi.fn() }))
vi.mock('@/lib/signal/store', () => signalStore)
const alerts = vi.hoisted(() => ({ resolveChannel: vi.fn() }))
vi.mock('@/lib/signal/alerts', () => alerts)
const api = vi.hoisted(() => ({ slackApi: vi.fn() }))
vi.mock('@/lib/slack/api', () => api)

import { parseSignalConfig } from '@/lib/signal/config'
import { ingestF5bot, type RedditFetch } from '@/lib/reddit/ingest'
import { parseRedditJson } from '@/lib/reddit/parse'
import { COMMENT_JSON, PLAIN, POST_JSON } from './fixtures'

const fetchOk: RedditFetch = async (l) => parseRedditJson(l.commentId ? COMMENT_JSON : POST_JSON, l)
const cfg = (over: Record<string, unknown> = {}) => parseSignalConfig({ dry_run: false, slack: { team_id: 'T0AAA', channel_id: 'C0SALES', channel_name: 'sales' }, ...over })
const posts = () => api.slackApi.mock.calls.filter((c) => c[0] === 'chat.postMessage')

beforeEach(() => {
  vi.resetAllMocks()
  db.rows = []
  signalStore.getSignalConfig.mockResolvedValue(cfg({ reddit_live: true }))
  alerts.resolveChannel.mockResolvedValue({ team: 'T0AAA', channel: 'C0SALES', token: 'xoxb' })
  let n = 0
  api.slackApi.mockImplementation(async () => ({ ok: true, ts: `1700.000${++n}` }))
})

describe('ingestF5bot', () => {
  it('stores both mentions with handle, keyword and hot tag, and posts hot first', async () => {
    const r = await ingestF5bot({ message_id: 'm1', body: PLAIN }, fetchOk)
    expect(r).toMatchObject({ ok: true, live: true, links: 2, inserted: 2, duplicate: 0, posted: 2, failed: 0 })
    expect(db.rows.map((x) => [x.author, x.keyword, x.hot])).toEqual([
      ['small_pm_owner', 'appfolio', true],
      ['rental_rita', 'buildium', false],
    ])
    expect(posts()[0][2]).toMatchObject({ channel: 'C0SALES' })
    expect(posts()[0][2].text).toContain('🔥')
    expect(db.rows.every((x) => x.alert_status === 'posted' && x.slack_ts)).toBe(true)
  })

  it('the same email twice → one card each', async () => {
    await ingestF5bot({ body: PLAIN }, fetchOk)
    const again = await ingestF5bot({ body: PLAIN }, fetchOk)
    expect(again).toMatchObject({ inserted: 0, duplicate: 2, posted: 0 })
    expect(posts()).toHaveLength(2)
    expect(db.rows).toHaveLength(2)
  })

  it('reddit_live not set → dry run: cards saved, Slack never called', async () => {
    signalStore.getSignalConfig.mockResolvedValue(cfg())
    const r = await ingestF5bot({ body: PLAIN }, fetchOk)
    expect(r).toMatchObject({ live: false, inserted: 2, dry_run: 2, posted: 0 })
    expect(api.slackApi).not.toHaveBeenCalled()
    expect(alerts.resolveChannel).not.toHaveBeenCalled()
    expect(db.rows.every((x) => x.alert_status === 'dry_run' && Array.isArray(x.card))).toBe(true)
  })

  it("Reddit unreadable → still stored with F5Bot's snippet, no handle", async () => {
    const r = await ingestF5bot({ body: PLAIN }, async () => {
      throw new Error('reddit 403')
    })
    expect(r).toMatchObject({ inserted: 2, unreadable: 2, posted: 2 })
    expect(db.rows[0]).toMatchObject({ author: null, keyword: 'appfolio', fetch_error: 'reddit 403' })
    expect(String(db.rows[0].snippet)).toContain('fees keep going up')
    expect(JSON.stringify(posts()[0][2].blocks)).toContain('unknown handle')
  })

  it('Reddit unreadable but F5Bot names the author → handle from the email', async () => {
    const body = PLAIN.replace('Buildium has been fine', 'by u/rental_rita: Buildium has been fine')
    await ingestF5bot({ body }, async () => {
      throw new Error('reddit 403')
    })
    expect(db.rows[1]).toMatchObject({ author: 'rental_rita', fetch_error: 'reddit 403' })
  })

  it('a failed send releases the claim; the next email retries it', async () => {
    api.slackApi.mockRejectedValueOnce(new Error('slack 500'))
    const r = await ingestF5bot({ body: PLAIN }, fetchOk)
    expect(r).toMatchObject({ ok: false, posted: 1, failed: 1 })
    expect(db.rows.filter((x) => x.alert_status === null)).toHaveLength(1)
    const next = await ingestF5bot({ body: 'nothing new' }, fetchOk)
    expect(next).toMatchObject({ ok: true, links: 0, posted: 1 })
    expect(db.rows.every((x) => x.alert_status === 'posted')).toBe(true)
  })

  it('channel problems stop before any claim', async () => {
    alerts.resolveChannel.mockResolvedValue({ error: 'bot_not_in_channel:#sales' })
    const r = await ingestF5bot({ body: PLAIN }, fetchOk)
    expect(r).toMatchObject({ ok: false, errors: ['bot_not_in_channel:#sales'] })
    expect(db.rows.every((x) => x.alert_status === null)).toBe(true)
  })

  it('no links → nothing stored, nothing sent', async () => {
    const r = await ingestF5bot({ body: 'hello' }, fetchOk)
    expect(r).toMatchObject({ ok: true, links: 0, inserted: 0 })
    expect(api.slackApi).not.toHaveBeenCalled()
  })
})
