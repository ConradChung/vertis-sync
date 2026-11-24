import { beforeEach, describe, expect, it, vi } from 'vitest'

// An in-memory signal_reddit_mentions with the real store's conditional semantics.
type Row = Record<string, unknown> & { id: number; permalink: string; alert_status: string | null; slack_ts: string | null; hot: boolean }
const db = vi.hoisted(() => ({ rows: [] as Row[] }))
const saved = vi.hoisted(() => ({ emails: [] as Record<string, unknown>[] }))
vi.mock('@/lib/reddit/store', () => ({
  saveEmail: async (e: Record<string, unknown>) => {
    saved.emails.push(e)
  },
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
  listEmails: async () => saved.emails,
  mentionsMissingSnippet: async (keys: string[]) => db.rows.filter((r) => keys.includes(r.permalink) && r.snippet == null),
  fillMentionText: async (id: number, p: Record<string, unknown>) => {
    const r = db.rows.find((x) => x.id === id && x.snippet == null)
    if (!r) return null
    Object.assign(r, p)
    return { ...r }
  },
  releaseMention: async (id: number) => {
    const r = db.rows.find((x) => x.id === id && x.alert_status === 'posted' && !x.slack_ts)
    if (r) r.alert_status = null
  },
}))
const sum = vi.hoisted(() => ({ summarizeExcerpt: vi.fn() }))
vi.mock('@/lib/reddit/summary', () => sum)
const signalStore = vi.hoisted(() => ({ getSignalConfig: vi.fn() }))
vi.mock('@/lib/signal/store', () => signalStore)
const alerts = vi.hoisted(() => ({ resolveChannel: vi.fn() }))
vi.mock('@/lib/signal/alerts', () => alerts)
const api = vi.hoisted(() => ({ slackApi: vi.fn() }))
vi.mock('@/lib/slack/api', () => api)

import { parseSignalConfig } from '@/lib/signal/config'
import { backfillExcerpts, ingestF5bot, type RedditFetch } from '@/lib/reddit/ingest'
import { parseRedditJson } from '@/lib/reddit/parse'
import { COMMENT_JSON, PLAIN, POST_JSON, REAL_HTML, REAL_HTML_PLAIN } from './fixtures'

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
  sum.summarizeExcerpt.mockImplementation(async ({ excerpt }: { excerpt: string }) => `SUM: ${excerpt.slice(0, 20)}`)
  saved.emails = []
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

  it('Reddit unreadable → still stored, no handle, no junk snippet', async () => {
    const r = await ingestF5bot({ body: PLAIN }, async () => {
      throw new Error('reddit 403')
    })
    expect(r).toMatchObject({ inserted: 2, unreadable: 2, posted: 2 })
    expect(db.rows[0]).toMatchObject({ author: null, keyword: 'appfolio', fetch_error: 'reddit 403' })
    expect(db.rows[0].snippet).toBeNull() // no Reddit text, and F5Bot's header is never used as a snippet
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

  it('keeps the email as received when it has a message id', async () => {
    saved.emails = []
    await ingestF5bot({ message_id: 'gm1', subject: 'F5Bot found something!', body: PLAIN, html: '<p>x</p>' }, fetchOk)
    await ingestF5bot({ body: PLAIN }, fetchOk)
    expect(saved.emails).toEqual([{ message_id: 'gm1', subject: 'F5Bot found something!', body: PLAIN, html: '<p>x</p>' }])
  })

  it('no links → nothing stored, nothing sent', async () => {
    const r = await ingestF5bot({ body: 'hello' }, fetchOk)
    expect(r).toMatchObject({ ok: true, links: 0, inserted: 0 })
    expect(api.slackApi).not.toHaveBeenCalled()
  })
})

describe("ingestF5bot on F5Bot's real layout", () => {
  it('title from the hit line, no header junk as snippet, hot from the title', async () => {
    const { REAL_PLAIN } = await import('./fixtures')
    signalStore.getSignalConfig.mockResolvedValue(cfg())
    await ingestF5bot({ body: REAL_PLAIN }, async () => {
      throw new Error('reddit 403')
    })
    expect(db.rows.map((x) => [x.author, x.title, x.snippet, x.keyword, x.hot])).toEqual([
      ['CoolWax', 'Maintenance Management System Recommendations', null, 'appfolio', false],
      ['TransportationOld902', "Don't love Buildium, switching from it?", null, 'buildium', true],
    ])
  })
})

describe('comment text from the HTML part', () => {
  const reddit403 = vi.fn(async () => {
    throw new Error('reddit 403')
  })
  const POST_KEY = 'https://www.reddit.com/r/propertymanagement/comments/1y1f63z/_/'
  const C1 = 'https://www.reddit.com/r/propertymanagement/comments/1y1f63z/_/19sxucq3repr9/'

  it('each hit gets its own excerpt and summary; Reddit is not asked when there is one', async () => {
    reddit403.mockClear()
    const r = await ingestF5bot({ message_id: 'm4', body: REAL_HTML_PLAIN, html: REAL_HTML }, reddit403)
    expect(r.ok).toBe(true)
    const byKey = new Map(db.rows.map((x) => [x.permalink, x]))
    expect(byKey.get(C1)).toMatchObject({ snippet: expect.stringContaining('nickel and dime'), summary: 'SUM: Appfolios native wor', fetch_error: null })
    expect(byKey.get(POST_KEY)).toMatchObject({ snippet: expect.stringContaining('college coding project'), hot: true })
    expect(String(byKey.get(POST_KEY)!.snippet)).not.toContain('Do you have comments')
    expect(reddit403).not.toHaveBeenCalledWith(expect.objectContaining({ key: C1 }))
    const blocks = JSON.stringify(posts().map((c) => c[2].blocks))
    expect(blocks).toContain('💬 SUM: Appfolios native wor')
    expect(blocks).toContain('nickel and dime')
  })

  it('a failed summary still stores the excerpt (no 💬 line)', async () => {
    sum.summarizeExcerpt.mockResolvedValue(null)
    await ingestF5bot({ body: REAL_HTML_PLAIN, html: REAL_HTML }, reddit403)
    expect(db.rows.find((x) => x.permalink === C1)).toMatchObject({ summary: null, snippet: expect.stringContaining('pretty weak') })
    expect(JSON.stringify(posts()[0][2].blocks)).not.toContain('💬')
  })

  it('no HTML part → title-only, as before', async () => {
    await ingestF5bot({ body: REAL_HTML_PLAIN }, reddit403)
    expect(db.rows.every((x) => x.snippet === null && x.summary === null)).toBe(true)
    expect(sum.summarizeExcerpt).not.toHaveBeenCalled()
  })

  it('backfill fills posted title-only cards and edits them in place, once', async () => {
    await ingestF5bot({ body: REAL_HTML_PLAIN }, reddit403) // posted title-only
    const postedTs = db.rows.map((x) => x.slack_ts)
    api.slackApi.mockClear()
    saved.emails = [{ message_id: 'm4', subject: 's', html: REAL_HTML }]
    const r = await backfillExcerpts()
    expect(r).toMatchObject({ ok: true, emails: 1 })
    expect(r.filled).toBeGreaterThan(0)
    expect(r.updated).toBe(r.filled)
    const calls = api.slackApi.mock.calls
    expect(calls.every((c) => c[0] === 'chat.update')).toBe(true)
    expect(calls.map((c) => c[2].ts).every((ts) => postedTs.includes(ts))).toBe(true)
    expect(JSON.stringify(calls.map((c) => c[2].blocks))).toContain('💬 SUM:')
    api.slackApi.mockClear()
    expect(await backfillExcerpts()).toMatchObject({ filled: 0, updated: 0 })
    expect(api.slackApi).not.toHaveBeenCalled()
  })
})
