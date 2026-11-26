import { describe, expect, it } from 'vitest'
import { applyState, countByStatus, domainOf, filterRows, isUntouched, mergeSignals, normalizeName, placeholderEmail, type SignalEvent, type SignalState } from '@/lib/signals/merge'

const ev = (over: Partial<SignalEvent> & Pick<SignalEvent, 'source' | 'ref'>): SignalEvent => ({
  company: null, site: null, at: null, label: 'signal', url: null, phone: null, person: null, person_title: null, linkedin: null, handle: null, ...over,
})

describe('domainOf', () => {
  it('reduces a URL or domain to the bare lowercase domain', () => {
    for (const raw of ['acme.com', 'ACME.com', 'https://www.acme.com/', 'http://acme.com/careers?x=1#top', 'www.acme.com:443/path', ' https://WWW.Acme.com ', 'acme.com.']) {
      expect(domainOf(raw), raw).toBe('acme.com')
    }
    expect(domainOf('https://careers.acme.co.uk/jobs')).toBe('careers.acme.co.uk')
  })
  it('is null for nothing usable and for hosts that are not the company (profiles, job boards)', () => {
    for (const raw of [null, undefined, '', '   ', 'acme', 'not a domain', 'https://', 'https://www.linkedin.com/company/acme', 'facebook.com/acme', 'boards.greenhouse.io/acme', 'https://acme.wixsite.com/home']) {
      expect(domainOf(raw), String(raw)).toBeNull()
    }
  })
})

describe('normalizeName', () => {
  it('ignores case, punctuation, accents, "&", a leading "the" and legal suffixes', () => {
    const same = ['Acme Property Management', 'ACME PROPERTY MANAGEMENT', 'Acme Property Management, LLC.', 'The Acme Property Management Co', 'Acme  Property   Management Inc', 'Acmé Property Management']
    expect(new Set(same.map(normalizeName))).toEqual(new Set(['acme property management']))
    expect(normalizeName('Smith & Sons')).toBe(normalizeName('Smith and Sons'))
    expect(normalizeName("O'Brien Realty")).toBe('obrien realty')
  })
  it('keeps the words that tell two companies apart', () => {
    expect(normalizeName('Acme Property Management')).not.toBe(normalizeName('Acme Realty'))
    expect(normalizeName('Acme Group')).not.toBe(normalizeName('Acme'))
    expect(normalizeName(null)).toBe('')
    expect(normalizeName('LLC')).toBe('')
  })
})

describe('mergeSignals (one row per company)', () => {
  it('merges every source for the same domain into one row, however the domain is written', () => {
    const rows = mergeSignals([
      ev({ source: 'hiring', ref: 'hiring:1', company: 'Acme PM', site: 'acme.com', at: '2026-11-20T10:00:00Z', label: 'Hiring: Regional PM', phone: '(310) 555-0101' }),
      ev({ source: 'comment', ref: 'comment:9', company: 'Acme Property Management LLC', site: 'https://www.acme.com/about', at: '2026-11-25T10:00:00Z', label: 'Commented on a post', person: 'Ada Lovelace', person_title: 'COO' }),
      ev({ source: 'influencer', ref: 'influencer:44', company: 'ACME PM', site: 'http://ACME.com', at: '2026-11-22T10:00:00Z', label: 'Reacted to a post', person: 'Bob Stone' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: 'd:acme.com',
      domain: 'acme.com',
      name: 'Acme Property Management LLC',
      sources: ['hiring', 'comment', 'influencer'],
      count: 3,
      newest: { source: 'comment', label: 'Commented on a post', at: '2026-11-25T10:00:00Z' },
      phone: '(310) 555-0101',
    })
    expect(rows[0].contacts.map((c) => c.name)).toEqual(['Ada Lovelace', 'Bob Stone'])
    expect(rows[0].events.map((e) => e.ref)).toEqual(['comment:9', 'influencer:44', 'hiring:1'])
  })

  it('falls back to the normalized name when there is no domain', () => {
    const rows = mergeSignals([
      ev({ source: 'influencer', ref: 'influencer:1', company: 'Blue Door Rentals, Inc.', at: '2026-11-01T00:00:00Z' }),
      ev({ source: 'comment', ref: 'comment:2', company: 'blue door rentals', at: '2026-11-02T00:00:00Z' }),
      ev({ source: 'hiring', ref: 'hiring:3', company: 'Blue Door Realty', at: '2026-11-03T00:00:00Z' }),
    ])
    expect(rows.map((r) => [r.key, r.count])).toEqual([['n:blue door realty', 1], ['n:blue door rentals', 2]])
    expect(rows[1].domain).toBeNull()
  })

  it('a row with only a name joins the domain that name belongs to, when there is exactly one', () => {
    const rows = mergeSignals([
      ev({ source: 'hiring', ref: 'hiring:1', company: 'Acme PM', site: 'acme.com', at: '2026-11-20T00:00:00Z' }),
      ev({ source: 'influencer', ref: 'influencer:2', company: 'Acme PM LLC', at: '2026-11-21T00:00:00Z' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'd:acme.com', count: 2, aliases: ['n:acme pm'] })
  })

  it('but stays apart when the name is used by two different domains', () => {
    const rows = mergeSignals([
      ev({ source: 'hiring', ref: 'hiring:1', company: 'Summit Management', site: 'summit-tx.com' }),
      ev({ source: 'hiring', ref: 'hiring:2', company: 'Summit Management', site: 'summitmgmt.co' }),
      ev({ source: 'influencer', ref: 'influencer:3', company: 'Summit Management' }),
    ])
    expect(rows.map((r) => r.key).sort()).toEqual(['d:summit-tx.com', 'd:summitmgmt.co', 'n:summit management'])
  })

  it('two companies sharing a name but not a domain are two rows; same domain with different names is one', () => {
    const rows = mergeSignals([
      ev({ source: 'hiring', ref: 'hiring:1', company: 'Keystone', site: 'keystone-a.com' }),
      ev({ source: 'hiring', ref: 'hiring:2', company: 'Keystone', site: 'keystone-b.com' }),
      ev({ source: 'comment', ref: 'comment:3', company: 'Keystone Residential', site: 'keystone-a.com' }),
    ])
    expect(rows.map((r) => [r.key, r.count]).sort()).toEqual([['d:keystone-a.com', 2], ['d:keystone-b.com', 1]])
  })

  it('a shared host is not a domain: a LinkedIn company page falls back to the name', () => {
    const rows = mergeSignals([
      ev({ source: 'comment', ref: 'comment:1', company: 'Harbor Homes', site: 'https://www.linkedin.com/company/harbor-homes' }),
      ev({ source: 'influencer', ref: 'influencer:2', company: 'Harbor Homes', site: 'https://www.linkedin.com/company/other' }),
    ])
    expect(rows.map((r) => [r.key, r.count])).toEqual([['n:harbor homes', 2]])
  })

  it('a Reddit mention has no company: its author is the account, and repeat mentions merge', () => {
    const rows = mergeSignals([
      ev({ source: 'reddit', ref: 'reddit:1', handle: 'PM_Dave', at: '2026-11-20T00:00:00Z', label: 'r/PropertyManagement: after-hours calls' }),
      ev({ source: 'reddit', ref: 'reddit:2', handle: 'u/pm_dave', at: '2026-11-24T00:00:00Z', label: 'r/Landlord: answering service?' }),
      ev({ source: 'reddit', ref: 'reddit:3', handle: null }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'r:pm_dave', name: 'u/pm_dave', count: 2, sources: ['reddit'], newest: { label: 'r/Landlord: answering service?' } })
  })

  it('sorts by the newest signal, undated rows last; rows with nothing to key on are dropped', () => {
    const rows = mergeSignals([
      ev({ source: 'hiring', ref: 'hiring:1', company: 'Old Co', at: '2026-10-01T00:00:00Z' }),
      ev({ source: 'hiring', ref: 'hiring:2', company: 'No Date Co' }),
      ev({ source: 'hiring', ref: 'hiring:3', company: 'New Co', at: '2026-11-25T00:00:00Z' }),
      ev({ source: 'hiring', ref: 'hiring:4', company: '  ', site: 'nope' }),
      ev({ source: 'hiring', ref: 'hiring:5', company: 'LLC' }),
    ])
    expect(rows.map((r) => r.name)).toEqual(['New Co', 'Old Co', 'No Date Co'])
  })

  it('keeps at most five signals and three contacts, without repeating a person', () => {
    const events = Array.from({ length: 8 }, (_, i) => ev({ source: 'influencer', ref: `influencer:${i}`, company: 'Big Co', site: 'big.co', at: `2026-11-${10 + i}T00:00:00Z`, person: i < 2 ? 'Ada' : `Person ${i}` }))
    const [row] = mergeSignals(events)
    expect(row.count).toBe(8)
    expect(row.events).toHaveLength(5)
    expect(row.events[0].ref).toBe('influencer:7')
    expect(row.contacts.map((c) => c.name)).toEqual(['Person 7', 'Person 6', 'Person 5'])
  })

  it('is empty for no events and does not change its input', () => {
    const events = [ev({ source: 'hiring', ref: 'hiring:1', company: 'A', site: 'a.com' })]
    const copy = JSON.stringify(events)
    expect(mergeSignals([])).toEqual([])
    mergeSignals(events)
    expect(JSON.stringify(events)).toBe(copy)
  })
})

describe('status and touches', () => {
  const accounts = mergeSignals([
    ev({ source: 'hiring', ref: 'hiring:1', company: 'Acme PM', site: 'acme.com', at: '2026-11-20T00:00:00Z' }),
    ev({ source: 'influencer', ref: 'influencer:2', company: 'Acme PM' }),
    ev({ source: 'comment', ref: 'comment:3', company: 'Blue Door', at: '2026-11-19T00:00:00Z' }),
    ev({ source: 'reddit', ref: 'reddit:4', handle: 'pm_dave', at: '2026-11-18T00:00:00Z' }),
  ])
  const state = (over: Partial<SignalState> & { account_key: string }): SignalState => ({ status: 'new', email_touched_at: null, linkedin_touched_at: null, call_touched_at: null, deal_id: null, ...over })

  it('an account with nothing saved is new and untouched', () => {
    const rows = applyState(accounts, [])
    expect(rows.map((r) => [r.key, r.status, r.state_key])).toEqual([['d:acme.com', 'new', 'd:acme.com'], ['n:blue door', 'new', 'n:blue door'], ['r:pm_dave', 'new', 'r:pm_dave']])
    expect(rows.every(isUntouched)).toBe(true)
  })

  it('applies saved status, touches and the deal', () => {
    const rows = applyState(accounts, [state({ account_key: 'n:blue door', status: 'working', call_touched_at: '2026-11-26T18:00:00Z', deal_id: 'deal-1' })])
    expect(rows[1]).toMatchObject({ status: 'working', deal_id: 'deal-1', touches: { email: null, linkedin: null, call: '2026-11-26T18:00:00Z' } })
    expect(isUntouched(rows[1])).toBe(false)
    expect(isUntouched(rows[0])).toBe(true)
  })

  it('state saved under the name still applies after the row gains a domain; the domain key wins when both exist', () => {
    const old = state({ account_key: 'n:acme pm', status: 'replied' })
    expect(applyState(accounts, [old])[0]).toMatchObject({ key: 'd:acme.com', status: 'replied', state_key: 'n:acme pm' })
    expect(applyState(accounts, [old, state({ account_key: 'd:acme.com', status: 'dropped' })])[0]).toMatchObject({ status: 'dropped', state_key: 'd:acme.com' })
  })

  it('a touch alone makes a row touched even while its status is still new', () => {
    const rows = applyState(accounts, [state({ account_key: 'r:pm_dave', linkedin_touched_at: '2026-11-26T18:00:00Z' })])
    expect(rows[2].status).toBe('new')
    expect(isUntouched(rows[2])).toBe(false)
  })

  it('filters by source, status and search; counts by status', () => {
    const rows = applyState(accounts, [state({ account_key: 'n:blue door', status: 'working' }), state({ account_key: 'r:pm_dave', status: 'dropped' })])
    expect(filterRows(rows, { source: 'hiring' }).map((r) => r.key)).toEqual(['d:acme.com'])
    expect(filterRows(rows, { source: 'influencer' }).map((r) => r.key)).toEqual(['d:acme.com'])
    expect(filterRows(rows, { status: 'open' }).map((r) => r.key)).toEqual(['d:acme.com', 'n:blue door'])
    expect(filterRows(rows, { status: 'dropped' }).map((r) => r.key)).toEqual(['r:pm_dave'])
    expect(filterRows(rows, { q: 'ACME' }).map((r) => r.key)).toEqual(['d:acme.com'])
    expect(filterRows(rows, { source: 'all', status: 'all' })).toHaveLength(3)
    expect(countByStatus(rows)).toEqual({ new: 1, working: 1, replied: 0, dropped: 1 })
  })
})

describe('placeholderEmail', () => {
  it('is a lowercase address on .invalid, stable per account', () => {
    expect(placeholderEmail('d:acme.com')).toBe('acme-com@signal.invalid')
    expect(placeholderEmail('n:blue door rentals')).toBe('blue-door-rentals@signal.invalid')
    expect(placeholderEmail('r:PM_Dave')).toBe('pm-dave@signal.invalid')
    expect(placeholderEmail('d:')).toBe('account@signal.invalid')
  })
})
