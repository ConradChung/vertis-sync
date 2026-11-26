import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A stand-in for the Supabase client. Source tables answer from `tables`;
 * `signal_accounts` behaves like the real table for the calls the store
 * makes (insert-if-absent, filtered update, select). Every call is recorded,
 * so the tests can assert what was written and that sources are only read.
 */
type Row = Record<string, unknown>
type Rec = { table: string; calls: [string, ...unknown[]][] }
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  fail: new Set<string>(),
  made: [] as { table: string; calls: [string, ...unknown[]][] }[],
}))

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const rec: Rec = { table, calls: [] }
      db.made.push(rec)
      const filters: ((r: Row) => boolean)[] = []
      let write: { kind: 'upsert' | 'update'; row: Row; ignore?: boolean } | null = null
      const run = (single: boolean) => {
        if (db.fail.has(table)) return { data: null, error: { message: 'boom' } }
        const rows = (db.tables[table] ?? []) as Row[]
        if (write?.kind === 'upsert') {
          const exists = rows.some((r) => r.account_key === write!.row.account_key)
          if (!exists) db.tables[table] = [...rows, { status: 'new', email_touched_at: null, linkedin_touched_at: null, call_touched_at: null, deal_id: null, ...write.row }]
          else if (!write.ignore) db.tables[table] = rows.map((r) => (r.account_key === write!.row.account_key ? { ...r, ...write!.row } : r))
          return { data: null, error: null }
        }
        if (write?.kind === 'update') {
          db.tables[table] = rows.map((r) => (filters.every((f) => f(r)) ? { ...r, ...write!.row } : r))
          return { data: null, error: null }
        }
        const hit = rows.filter((r) => filters.every((f) => f(r)))
        return { data: single ? (hit[0] ?? null) : hit, error: null }
      }
      const b: Record<string, unknown> = {}
      const chain = (m: string, fn?: (...a: unknown[]) => void) => {
        b[m] = (...args: unknown[]) => {
          rec.calls.push([m, ...args])
          fn?.(...args)
          return b
        }
      }
      for (const m of ['select', 'order', 'limit', 'in', 'insert', 'delete']) chain(m)
      // Filters only narrow signal_accounts; the fixtures for source tables are already the rows the query would return.
      chain('eq', (col, val) => table === 'signal_accounts' && filters.push((r) => r[String(col)] === val))
      chain('is', (col, val) => table === 'signal_accounts' && filters.push((r) => (r[String(col)] ?? null) === val))
      chain('upsert', (row, opts) => (write = { kind: 'upsert', row: row as Row, ignore: !!(opts as { ignoreDuplicates?: boolean })?.ignoreDuplicates }))
      chain('update', (row) => (write = { kind: 'update', row: row as Row }))
      b.maybeSingle = () => Promise.resolve(run(true))
      b.single = () => Promise.resolve(run(true))
      b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(run(false)).then(ok, bad)
      return b
    },
  }),
}))

const crm = vi.hoisted(() => ({ ensureDeal: vi.fn(), getDeal: vi.fn(), setStage: vi.fn() }))
vi.mock('@/lib/crm/service', () => crm)

import { placeholderEmail } from '@/lib/signals/merge'
import { loadEvents, loadInbox, patchAccount, startDeal } from '@/lib/signals/store'

const SOURCES = ['signal_hiring', 'signal_people', 'signal_posts', 'signal_reddit_mentions', 'influencer_reactors']
const NOW = new Date('2026-11-26T20:00:00Z')
const account = (key: string) => (db.tables.signal_accounts ?? []).find((r) => r.account_key === key)
const state = (key: string, o: Row = {}): Row => ({ account_key: key, status: 'new', email_touched_at: null, linkedin_touched_at: null, call_touched_at: null, deal_id: null, ...o })
const writes = (table: string) => db.made.filter((r) => r.table === table && r.calls.some(([m]) => ['upsert', 'update', 'insert', 'delete'].includes(m)))
/** The columns each write to signal_accounts carried, in order. */
const written = () => writes('signal_accounts').map((r) => Object.keys(r.calls.find(([m]) => m === 'upsert' || m === 'update')![1] as Row).sort())

beforeEach(() => {
  vi.clearAllMocks()
  db.made.length = 0
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
    db.tables.signal_accounts = [state('r:pm_dave', { status: 'dropped' })]
    const inbox = await loadInbox({ status: 'open', source: 'all' })
    expect(inbox.rows.map((r) => r.key)).toEqual(['d:acme.com', 'n:stone rentals'])
    expect(inbox.counts).toEqual({ new: 2, working: 0, replied: 0, dropped: 1 })
    expect((await loadInbox({ source: 'influencer' })).rows.map((r) => r.key)).toEqual(['n:stone rentals'])
    const capped = await loadInbox({}, 1)
    expect(capped.rows).toHaveLength(1)
    expect(capped.total).toBe(3)
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
    await patchAccount('d:acme.com', { touch: { channel: 'email', done: true } }, NOW)
    await startDeal('d:acme.com', NOW)
    for (const t of SOURCES) expect(writes(t), t).toHaveLength(0)
    expect(db.made.find((r) => r.table === 'influencer_reactors')!.calls).toContainEqual(['eq', 'verdict', 'verified'])
    expect(db.made.find((r) => r.table === 'signal_hiring')!.calls).toContainEqual(['eq', 'stage', 'done'])
  })
})

describe('patchAccount (status and touches)', () => {
  it('a touch is stamped with the time and moves a new account to working', async () => {
    const s = await patchAccount('d:acme.com', { touch: { channel: 'call', done: true } }, NOW)
    expect(s).toMatchObject({ account_key: 'd:acme.com', status: 'working', call_touched_at: NOW.toISOString(), email_touched_at: null, linkedin_touched_at: null })
    expect(account('d:acme.com')).toMatchObject({ company_name: 'Acme Property Management', domain: 'acme.com' })
  })

  it('writes one column per change, never the whole row, so two saves at once cannot undo each other', async () => {
    await patchAccount('d:acme.com', { touch: { channel: 'call', done: true } }, NOW)
    // 1. create the row if absent (identity only), 2. the one touch column, 3. new -> working.
    expect(written()).toEqual([['account_key', 'company_name', 'domain'], ['call_touched_at', 'updated_at'], ['status', 'updated_at']])
    const tick = writes('signal_accounts')[1].calls
    expect(tick).toContainEqual(['is', 'call_touched_at', null])
    expect(writes('signal_accounts')[2].calls).toContainEqual(['eq', 'status', 'new'])
    db.made.length = 0
    await patchAccount('d:acme.com', { status: 'replied' }, NOW)
    expect(written()).toEqual([['account_key', 'company_name', 'domain'], ['status', 'updated_at']])
    // The earlier call tick is untouched by the status save.
    expect(account('d:acme.com')).toMatchObject({ status: 'replied', call_touched_at: NOW.toISOString() })
  })

  it('a save that lands between another save\'s read and write is not lost', async () => {
    // A tick arrives while a status change is in flight: each wrote only its own column.
    await Promise.all([patchAccount('d:acme.com', { status: 'replied' }, NOW), patchAccount('d:acme.com', { touch: { channel: 'email', done: true } }, NOW)])
    expect(account('d:acme.com')).toMatchObject({ status: 'replied', email_touched_at: NOW.toISOString() })
  })

  it('a second tick keeps the first time; unticking clears it and leaves the status alone', async () => {
    db.tables.signal_accounts = [state('d:acme.com', { status: 'replied', email_touched_at: '2026-11-20T10:00:00.000Z' })]
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
    expect(await patchAccount('r:pm_dave', { status: 'new', touch: { channel: 'linkedin', done: true } }, NOW)).toMatchObject({ status: 'new', linkedin_touched_at: NOW.toISOString() })
  })

  it('writes under the key the state already lives under (a name key from before the row had a domain)', async () => {
    db.tables.signal_accounts = [state('n:acme pm', { status: 'working' })]
    const s = await patchAccount('d:acme.com', { status: 'replied' }, NOW)
    expect(s).toMatchObject({ account_key: 'n:acme pm', status: 'replied' })
    expect(account('d:acme.com')).toBeUndefined()
  })

  it('a key that is not an account in the inbox saves nothing', async () => {
    expect(await patchAccount('d:not-a-signal.com', { status: 'working' }, NOW)).toBeNull()
    expect(writes('signal_accounts')).toHaveLength(0)
  })
})

describe('startDeal', () => {
  it('creates a deal under the signals campaign and moves it to Conversation, then links it and marks the account working', async () => {
    const out = await startDeal('d:acme.com', NOW)
    expect(out).toEqual({ ok: true, deal_id: 'deal-1', campaign_id: 'signals', created: true })
    expect(crm.ensureDeal).toHaveBeenCalledWith({ campaign_id: 'signals', email: placeholderEmail('d:acme.com'), source: 'user', name: 'Ada Lovelace', company: 'Acme Property Management' })
    expect(crm.ensureDeal.mock.calls[0][0].email).toMatch(/^d-acme-com-[a-z0-9]+@signal\.invalid$/)
    expect(crm.setStage).toHaveBeenCalledWith('deal-1', 'Conversation', 'user', null, { via: 'signals', account_key: 'd:acme.com' })
    expect(account('d:acme.com')).toMatchObject({ deal_id: 'deal-1', status: 'working' })
    // Identity on create, then deal_id alone, then new -> working alone.
    expect(written()).toEqual([['account_key', 'company_name', 'domain'], ['deal_id', 'updated_at'], ['status', 'updated_at']])
  })

  it('keeps touches ticked earlier and a status the owner already set', async () => {
    db.tables.signal_accounts = [state('d:acme.com', { status: 'replied', call_touched_at: '2026-11-25T18:00:00.000Z' })]
    await startDeal('d:acme.com', NOW)
    expect(account('d:acme.com')).toMatchObject({ deal_id: 'deal-1', status: 'replied', call_touched_at: '2026-11-25T18:00:00.000Z' })
  })

  it('pressing it again returns the same deal without creating or moving anything', async () => {
    db.tables.signal_accounts = [state('d:acme.com', { status: 'replied', deal_id: 'deal-1' })]
    crm.getDeal.mockResolvedValue({ id: 'deal-1', campaign_id: 'signals', stage: 'Pilot' })
    expect(await startDeal('d:acme.com', NOW)).toEqual({ ok: true, deal_id: 'deal-1', campaign_id: 'signals', created: false })
    expect(crm.ensureDeal).not.toHaveBeenCalled()
    expect(crm.setStage).not.toHaveBeenCalled()
    expect(writes('signal_accounts')).toHaveLength(0)
  })

  it('a deal the owner already moved on is linked but not pulled back to Conversation', async () => {
    crm.ensureDeal.mockResolvedValue({ id: 'deal-7', campaign_id: 'signals', stage: 'Demo', created_at: '2026-11-01T00:00:00Z' })
    expect(await startDeal('d:acme.com', NOW)).toMatchObject({ deal_id: 'deal-7', created: false })
    expect(crm.setStage).not.toHaveBeenCalled()
    expect(account('d:acme.com')).toMatchObject({ deal_id: 'deal-7' })
  })

  it('two different accounts never get the same deal address', async () => {
    await startDeal('d:acme.com', NOW)
    await startDeal('n:stone rentals', NOW)
    await startDeal('r:pm_dave', NOW)
    const emails = crm.ensureDeal.mock.calls.map(([d]) => d.email)
    expect(new Set(emails).size).toBe(3)
    for (const e of emails) expect(e.endsWith('@signal.invalid')).toBe(true)
  })

  it('an unknown key starts nothing', async () => {
    expect(await startDeal('n:nobody', NOW)).toEqual({ ok: false, error: 'not_found' })
    expect(crm.ensureDeal).not.toHaveBeenCalled()
  })
})
