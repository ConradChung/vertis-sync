import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A stand-in for the Supabase client: each table answers from `tables`, and
 * every call is recorded so the tests can assert that the four source tables
 * are only ever read.
 */
type Rec = { table: string; calls: [string, ...unknown[]][] }
const db = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  fail: new Set<string>(),
  made: [] as { table: string; calls: [string, ...unknown[]][] }[],
  upserts: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const rec: Rec = { table, calls: [] }
      db.made.push(rec)
      let single = false
      let keyFilter: string | null = null
      const answer = () => {
        if (db.fail.has(table)) return { data: null, error: { message: 'boom' } }
        const rows = db.tables[table] ?? []
        if (table === 'signal_accounts' && rec.calls.some(([m]) => m === 'upsert')) {
          const row = rec.calls.find(([m]) => m === 'upsert')![1] as Record<string, unknown>
          db.upserts.push(row)
          const list = (db.tables.signal_accounts ?? []) as Record<string, unknown>[]
          db.tables.signal_accounts = [...list.filter((r) => r.account_key !== row.account_key), row]
          return { data: row, error: null }
        }
        if (single) return { data: (rows as Record<string, unknown>[]).find((r) => r.account_key === keyFilter) ?? null, error: null }
        return { data: rows, error: null }
      }
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'upsert', 'update', 'insert', 'delete']) {
        b[m] = (...args: unknown[]) => {
          rec.calls.push([m, ...args])
          if (m === 'eq' && args[0] === 'account_key') keyFilter = String(args[1])
          return b
        }
      }
      b.maybeSingle = () => {
        single = true
        return Promise.resolve(answer())
      }
      b.single = () => Promise.resolve(answer())
      b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(answer()).then(ok, bad)
      return b
    },
  }),
}))

const crm = vi.hoisted(() => ({ ensureDeal: vi.fn(), getDeal: vi.fn(), setStage: vi.fn() }))
vi.mock('@/lib/crm/service', () => crm)

import { loadEvents, loadInbox, patchAccount, startDeal } from '@/lib/signals/store'

const SOURCES = ['signal_hiring', 'signal_people', 'signal_posts', 'signal_reddit_mentions', 'influencer_reactors']
const NOW = new Date('2026-11-26T20:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  db.made.length = 0
  db.upserts.length = 0
  db.fail.clear()
  db.tables = {
    signal_hiring: [{ id: 1, signal: 'hiring', role_title: 'Regional PM', headline: null, source_url: null, posted_at: '2026-11-20T00:00:00Z', company_name: 'Acme PM', company_domain: 'acme.com', company_website: null, company_phone: '(310) 555-0101', person_name: null, person_title: null, person_linkedin: null, stage: 'done', skip_reason: null, status: 'new', created_at: '2026-11-20T00:00:00Z' }],
    signal_people: [{ id: 9, kind: 'commenter', stage: 'alerted', skip_reason: null, name: 'Ada Lovelace', title: 'COO', linkedin_url: null, company_name: 'Acme Property Management', company_website: 'https://acme.com', post_id: 'p1', comment_text: 'Yes', comment_url: null, commented_at: '2026-11-25T00:00:00Z', created_at: '2026-11-25T00:00:00Z' }],
    signal_posts: [{ post_id: 'p1', post_url: 'https://linkedin.com/posts/1', text_excerpt: 'x' }],
    signal_reddit_mentions: [{ id: 4, url: null, permalink: null, subreddit: 'Landlord', author: 'pm_dave', title: 'Answering service?', summary: null, snippet: null, alert_status: 'posted', reddit_created_at: '2026-11-24T00:00:00Z', created_at: '2026-11-24T00:00:00Z' }],
    influencer_reactors: [{ id: 44, name: 'Bob Stone', title: 'Owner', linkedin_url: null, company_name: 'Stone Rentals', company_website: null, reacted_to: ['frank22'], door_count: 900, verdict: 'verified', verified_at: '2026-11-10T00:00:00Z', updated_at: null }],
    signal_accounts: [],
  }
  crm.ensureDeal.mockResolvedValue({ id: 'deal-1', campaign_id: 'signals', stage: 'Contacted', created_at: NOW.toISOString() })
  crm.setStage.mockResolvedValue('Contacted')
  crm.getDeal.mockResolvedValue(null)
})

const writesTo = (table: string) => db.made.filter((r) => r.table === table && r.calls.some(([m]) => ['upsert', 'update', 'insert', 'delete'].includes(m)))

describe('loadInbox', () => {
  it('merges the four sources into one row per company, newest first, with counts', async () => {
    const inbox = await loadInbox()
    expect(inbox.rows.map((r) => [r.key, r.sources, r.status])).toEqual([
      ['d:acme.com', ['hiring', 'comment'], 'new'],
      ['r:pm_dave', ['reddit'], 'new'],
      ['n:stone rentals', ['influencer'], 'new'],
    ])
    expect(inbox.counts).toEqual({ new: 3, working: 0, replied: 0, dropped: 0 })
    expect(inbox.total).toBe(3)
    expect(inbox.failed).toEqual([])
  })

  it('applies saved state and the filter; counts stay over every account', async () => {
    db.tables.signal_accounts = [{ account_key: 'r:pm_dave', status: 'dropped', email_touched_at: null, linkedin_touched_at: null, call_touched_at: null, deal_id: null }]
    const inbox = await loadInbox({ status: 'open', source: 'all' })
    expect(inbox.rows.map((r) => r.key)).toEqual(['d:acme.com', 'n:stone rentals'])
    expect(inbox.counts).toEqual({ new: 2, working: 0, replied: 0, dropped: 1 })
    expect((await loadInbox({ source: 'influencer' })).rows.map((r) => r.key)).toEqual(['n:stone rentals'])
    expect((await loadInbox({}, 1)).rows).toHaveLength(1)
  })

  it('a source that fails is named and the others still load', async () => {
    db.fail.add('signal_reddit_mentions')
    const { events, failed } = await loadEvents()
    expect(failed).toEqual(['reddit'])
    expect(events.map((e) => e.source).sort()).toEqual(['comment', 'hiring', 'influencer'])
  })

  it('reads the source tables and never writes to them; only verified reactors and finished hiring rows are asked for', async () => {
    await loadInbox()
    await patchAccount('d:acme.com', { status: 'working' }, NOW)
    await startDeal('d:acme.com', NOW)
    for (const t of SOURCES) expect(writesTo(t), t).toHaveLength(0)
    expect(db.made.find((r) => r.table === 'influencer_reactors')!.calls).toContainEqual(['eq', 'verdict', 'verified'])
    expect(db.made.find((r) => r.table === 'signal_hiring')!.calls).toContainEqual(['eq', 'stage', 'done'])
  })
})

describe('patchAccount (status and touches)', () => {
  it('a touch is stamped with the time and moves a new account to working', async () => {
    const s = await patchAccount('d:acme.com', { touch: { channel: 'call', done: true } }, NOW)
    expect(s).toMatchObject({ account_key: 'd:acme.com', status: 'working', call_touched_at: NOW.toISOString(), email_touched_at: null, linkedin_touched_at: null })
    expect(db.upserts[0]).toMatchObject({ company_name: 'Acme Property Management', domain: 'acme.com' })
  })

  it('a second tick keeps the first time; unticking clears it and leaves the status alone', async () => {
    db.tables.signal_accounts = [{ account_key: 'd:acme.com', status: 'replied', email_touched_at: '2026-11-20T10:00:00.000Z', linkedin_touched_at: null, call_touched_at: null, deal_id: null }]
    expect(await patchAccount('d:acme.com', { touch: { channel: 'email', done: true } }, NOW)).toMatchObject({ email_touched_at: '2026-11-20T10:00:00.000Z', status: 'replied' })
    expect(await patchAccount('d:acme.com', { touch: { channel: 'email', done: false } }, NOW)).toMatchObject({ email_touched_at: null, status: 'replied' })
  })

  it('each channel has its own tick', async () => {
    await patchAccount('d:acme.com', { touch: { channel: 'email', done: true } }, NOW)
    const later = new Date('2026-11-27T20:00:00Z')
    const s = await patchAccount('d:acme.com', { touch: { channel: 'linkedin', done: true } }, later)
    expect(s).toMatchObject({ email_touched_at: NOW.toISOString(), linkedin_touched_at: later.toISOString(), call_touched_at: null })
  })

  it('a status is saved as given and keeps the touches; an explicit status wins over the first-touch rule', async () => {
    await patchAccount('d:acme.com', { touch: { channel: 'call', done: true } }, NOW)
    expect(await patchAccount('d:acme.com', { status: 'dropped' }, NOW)).toMatchObject({ status: 'dropped', call_touched_at: NOW.toISOString() })
    expect(await patchAccount('r:pm_dave', { status: 'new', touch: { channel: 'linkedin', done: true } }, NOW)).toMatchObject({ status: 'new' })
  })

  it('writes under the key the state already lives under (a name key from before the row had a domain)', async () => {
    db.tables.signal_accounts = [{ account_key: 'n:acme pm', status: 'working', email_touched_at: null, linkedin_touched_at: null, call_touched_at: null, deal_id: null }]
    const s = await patchAccount('d:acme.com', { status: 'replied' }, NOW)
    expect(s?.account_key).toBe('n:acme pm')
    expect(db.upserts).toHaveLength(1)
  })

  it('a key that is not an account in the inbox saves nothing', async () => {
    expect(await patchAccount('d:not-a-signal.com', { status: 'working' }, NOW)).toBeNull()
    expect(db.upserts).toHaveLength(0)
  })
})

describe('startDeal', () => {
  it('creates a deal under the signals campaign and moves it to Conversation, then links it and marks the account working', async () => {
    const out = await startDeal('d:acme.com', NOW)
    expect(out).toEqual({ ok: true, deal_id: 'deal-1', campaign_id: 'signals', created: true })
    expect(crm.ensureDeal).toHaveBeenCalledWith({ campaign_id: 'signals', email: 'acme-com@signal.invalid', source: 'user', name: 'Ada Lovelace', company: 'Acme Property Management' })
    expect(crm.setStage).toHaveBeenCalledWith('deal-1', 'Conversation', 'user', null, { via: 'signals', account_key: 'd:acme.com' })
    expect(db.upserts[0]).toMatchObject({ account_key: 'd:acme.com', deal_id: 'deal-1', status: 'working' })
  })

  it('pressing it again returns the same deal without creating or moving anything', async () => {
    db.tables.signal_accounts = [{ account_key: 'd:acme.com', status: 'replied', email_touched_at: null, linkedin_touched_at: null, call_touched_at: null, deal_id: 'deal-1' }]
    crm.getDeal.mockResolvedValue({ id: 'deal-1', campaign_id: 'signals', stage: 'Pilot' })
    expect(await startDeal('d:acme.com', NOW)).toEqual({ ok: true, deal_id: 'deal-1', campaign_id: 'signals', created: false })
    expect(crm.ensureDeal).not.toHaveBeenCalled()
    expect(crm.setStage).not.toHaveBeenCalled()
    expect(db.upserts).toHaveLength(0)
  })

  it('a deal the owner already moved on is linked but not pulled back to Conversation; the status it had is kept', async () => {
    db.tables.signal_accounts = [{ account_key: 'd:acme.com', status: 'replied', email_touched_at: null, linkedin_touched_at: null, call_touched_at: null, deal_id: null }]
    crm.ensureDeal.mockResolvedValue({ id: 'deal-7', campaign_id: 'signals', stage: 'Demo', created_at: '2026-11-01T00:00:00Z' })
    expect(await startDeal('d:acme.com', NOW)).toMatchObject({ deal_id: 'deal-7', created: false })
    expect(crm.setStage).not.toHaveBeenCalled()
    expect(db.upserts[0]).toMatchObject({ deal_id: 'deal-7', status: 'replied' })
  })

  it('an unknown key starts nothing', async () => {
    expect(await startDeal('n:nobody', NOW)).toEqual({ ok: false, error: 'not_found' })
    expect(crm.ensureDeal).not.toHaveBeenCalled()
  })
})
