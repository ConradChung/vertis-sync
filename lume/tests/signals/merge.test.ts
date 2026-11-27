import { describe, expect, it } from 'vitest'
import { applyState, byWarmth, companyName, countByStatus, domainOf, filterRows, isResearchOnly, isUntouched, mergeSignals, warmthOf, normalizeName, placeholderEmail, type SignalEvent, type SignalState } from '@/lib/signals/merge'

const ev = (over: Partial<SignalEvent> & Pick<SignalEvent, 'source' | 'ref'>): SignalEvent => ({
  company: null, site: null, at: null, label: 'signal', url: null, phone: null, person: null, person_title: null, linkedin: null, handle: null, ...over,
})

describe('domainOf', () => {
  it('reduces a URL or domain to the bare lowercase domain', () => {
    for (const raw of ['acme.com', 'ACME.com', 'https://www.acme.com/', 'http://acme.com/careers?x=1#top', 'www.acme.com:443/path', ' https://WWW.Acme.com ', 'acme.com.']) {
      expect(domainOf(raw), raw).toBe('acme.com')
    }
    expect(domainOf('https://shop.acme.co.uk/x')).toBe('shop.acme.co.uk')
  })
  it('a careers or jobs subdomain is a section of the same site, not another company', () => {
    for (const raw of ['https://careers.acme.com/jobs/12', 'jobs.acme.com', 'apply.acme.com', 'www.careers.acme.com']) expect(domainOf(raw), raw).toBe('acme.com')
    // But a bare "careers.com" is its own domain.
    expect(domainOf('careers.com')).toBe('careers.com')
  })
  it('never folds down to a country suffix, and a bare suffix is no domain', () => {
    expect(domainOf('careers.co.uk')).toBe('careers.co.uk')
    expect(domainOf('jobs.co.uk')).toBe('jobs.co.uk')
    expect(domainOf('careers.co.uk')).not.toBe(domainOf('jobs.co.uk'))
    expect(domainOf('jobs.ac.uk')).toBe('jobs.ac.uk')
    expect(domainOf('careers.com.au')).toBe('careers.com.au')
    expect(domainOf('careers.acme.co.uk')).toBe('acme.co.uk')
    for (const raw of ['co.uk', 'com.au']) expect(domainOf(raw), raw).toBeNull()
  })
  it('link shorteners, site builders, scheduling pages and mailbox providers are never a company domain', () => {
    for (const raw of [
      'https://lnkd.in/a', 'https://lnkd.in/b', 'goo.gl/maps/x', 'g.page/acme', 't.co/abc', 'fb.me/acme', 'wa.me/13105550101', 'calendly.com/jane', 'https://jane.wix.com/site',
      'acme.squarespace.com', 'acme.weebly.com', 'acme.wordpress.com', 'medium.com/@acme', 'github.com/acme', 'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
      'tinyurl.com/abc', 'fb.com/acme', 'youtu.be/xyz', 'rebrand.ly/a', 'about.me/jane', 'realtor.com/agent/1', 'bbb.org/acme', 'live.com', 'me.com', 'protonmail.com', 'proton.me',
    ]) {
      expect(domainOf(raw), raw).toBeNull()
    }
  })
  it('an email address is not a site', () => {
    for (const raw of ['john@gmail.com', 'jane@acme.com', ' Jane@Acme.com ']) expect(domainOf(raw), raw).toBeNull()
    // Credentials in a real URL are dropped and the host is kept.
    expect(domainOf('https://user:pw@acme.com/x')).toBe('acme.com')
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
  })
  it('strips a legal form only from the end of the name', () => {
    expect(normalizeName('LP Realty')).toBe('lp realty')
    expect(normalizeName('PC Homes')).toBe('pc homes')
    expect(normalizeName('Co-op Living Inc')).toBe('co op living')
    expect(normalizeName('Company Housing Group')).toBe('company housing group')
    expect(normalizeName('Acme Co., Ltd.')).toBe('acme')
    expect(normalizeName('Acme LP')).toBe('acme')
    expect(normalizeName('LP Realty')).not.toBe(normalizeName('PC Realty'))
  })
  it('reads dotted and joined legal forms the same as plain ones', () => {
    expect(normalizeName('Acme L.P.')).toBe(normalizeName('Acme LP'))
    expect(normalizeName('Acme L.L.P.')).toBe('acme')
    expect(normalizeName('Acme P.C.')).toBe('acme')
    expect(normalizeName('Acme & Co')).toBe('acme')
    expect(normalizeName('Acme and Company, Inc.')).toBe('acme')
    expect(normalizeName('Smith & Sons')).toBe('smith and sons')
    expect(normalizeName('Rock and Roll Rentals')).toBe('rock and roll rentals')
  })
  it('never reduces a real name to nothing: a bare legal form and a non-Latin name keep a key', () => {
    expect(normalizeName('Company')).toBe('company')
    expect(normalizeName('LLC')).toBe('llc')
    expect(normalizeName('不動産管理株式会社')).not.toBe('')
    expect(normalizeName('Недвижимость Плюс')).toBe('недвижимость плюс')
    expect(normalizeName('---')).toBe('')
    expect(normalizeName('x'.repeat(400)).length).toBeLessThanOrEqual(190)
  })
  it('an employer placeholder is not a company', () => {
    for (const raw of ['Self-employed', 'self employed', 'Freelance', 'Freelancer', 'Independent', 'Confidential', 'Stealth', 'Retired', 'Unemployed', 'None', 'N/A']) expect(companyName(raw), raw).toBe('')
    for (const raw of ['Independent Consultant', 'Career Break', 'Self-Employed (Freelance)', 'Self employed - real estate', 'Real Estate', 'Myself', 'Freelancing', 'Freelance Writer', 'Realtor', 'Landlord', 'Owner']) expect(companyName(raw), raw).toBe('')
    expect(companyName('Freelancers Union')).toBe('freelancers union')
    expect(companyName('Owner Managed Homes')).toBe('owner managed homes')
    expect(companyName('Independent Property Group')).toBe('independent property group')
    expect(companyName('Acme PM, LLC')).toBe('acme pm')
  })
})

describe('warmth and research', () => {
  const comment = (reaction: boolean) => ({ source: 'comment' as const, reaction, comment: null, post_url: null, post_excerpt: null })
  it('ranks a comment on his post, then a reaction to it, then hiring, then the rest', () => {
    expect(warmthOf({ source: 'comment', label: 'Commented: “x”', detail: comment(false) })).toBe(0)
    expect(warmthOf({ source: 'comment', label: 'Reacted to a watched post', detail: comment(true) })).toBe(1)
    expect(warmthOf({ source: 'comment', label: 'Reacted to a watched post' })).toBe(1)
    expect(warmthOf({ source: 'hiring', label: 'Hiring: PM' })).toBe(2)
    expect(warmthOf({ source: 'influencer', label: 'Reacted to Frank' })).toBe(3)
    expect(warmthOf({ source: 'reddit', label: 'r/x: y' })).toBe(3)
  })
  it('an account takes its warmest signal and that signal\'s time', () => {
    const [a] = mergeSignals([
      ev({ source: 'hiring', ref: 'hiring:1', company: 'Acme', site: 'acme.com', at: '2026-11-25T00:00:00Z' }),
      ev({ source: 'comment', ref: 'comment:1', company: 'Acme', site: 'acme.com', at: '2026-11-20T00:00:00Z', label: 'Commented: “hi”', detail: comment(false) }),
      ev({ source: 'comment', ref: 'comment:2', company: 'Acme', site: 'acme.com', at: '2026-11-10T00:00:00Z', label: 'Commented: “old”', detail: comment(false) }),
    ])
    expect(a.warmth).toEqual({ tier: 0, at: '2026-11-20T00:00:00Z' })
    const sorted = [
      { key: 'b', warmth: { tier: 2 as const, at: '2026-11-25T00:00:00Z' } },
      { key: 'a', warmth: { tier: 0 as const, at: '2026-11-01T00:00:00Z' } },
      { key: 'c', warmth: { tier: 0 as const, at: '2026-11-02T00:00:00Z' } },
    ].sort(byWarmth)
    expect(sorted.map((r) => r.key)).toEqual(['c', 'a', 'b'])
  })
  it('only an account whose every signal is Reddit is research', () => {
    expect(isResearchOnly({ sources: ['reddit'] })).toBe(true)
    expect(isResearchOnly({ sources: ['reddit', 'hiring'] })).toBe(false)
    expect(isResearchOnly({ sources: ['comment'] })).toBe(false)
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
      ev({ source: 'hiring', ref: 'hiring:5', company: '--' }),
    ])
    expect(rows.map((r) => r.name)).toEqual(['New Co', 'Old Co', 'No Date Co'])
  })

  it('two companies whose only site is a link shortener or a mailbox stay two rows', () => {
    const rows = mergeSignals([
      ev({ source: 'influencer', ref: 'influencer:1', company: 'Alpha Homes', site: 'https://lnkd.in/a' }),
      ev({ source: 'influencer', ref: 'influencer:2', company: 'Beta Rentals', site: 'https://lnkd.in/b' }),
      ev({ source: 'influencer', ref: 'influencer:3', company: 'Gamma PM', site: 'john@gmail.com' }),
      ev({ source: 'influencer', ref: 'influencer:4', company: 'Delta PM', site: 'calendly.com/delta' }),
    ])
    expect(rows.map((r) => r.key).sort()).toEqual(['n:alpha homes', 'n:beta rentals', 'n:delta pm', 'n:gamma pm'])
  })

  it('names that differ only by a leading legal-looking word are different companies', () => {
    const rows = mergeSignals([
      ev({ source: 'hiring', ref: 'hiring:1', company: 'LP Realty' }),
      ev({ source: 'hiring', ref: 'hiring:2', company: 'PC Realty' }),
      ev({ source: 'hiring', ref: 'hiring:3', company: 'Realty' }),
    ])
    expect(rows.map((r) => r.key).sort()).toEqual(['n:lp realty', 'n:pc realty', 'n:realty'])
  })

  it('"Self-employed" never groups people: it does not pull strangers into one person\'s domain, and alone it is no account', () => {
    const rows = mergeSignals([
      ev({ source: 'influencer', ref: 'influencer:1', company: 'Self-employed', site: 'janes-site.com', person: 'Jane' }),
      ev({ source: 'influencer', ref: 'influencer:2', company: 'Self-employed', person: 'Raj' }),
      ev({ source: 'influencer', ref: 'influencer:3', company: 'Self Employed', person: 'Lee' }),
      ev({ source: 'influencer', ref: 'influencer:4', company: 'Freelance', person: 'Kim' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'd:janes-site.com', count: 1, name: 'janes-site.com', aliases: [] })
  })

  it('a non-Latin company name keeps its row', () => {
    const rows = mergeSignals([ev({ source: 'hiring', ref: 'hiring:1', company: 'Недвижимость Плюс' }), ev({ source: 'hiring', ref: 'hiring:2', company: 'НЕДВИЖИМОСТЬ ПЛЮС, LLC' })])
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(2)
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

  it('state saved under a name is not shared when that name now belongs to two companies', () => {
    const summits = mergeSignals([
      ev({ source: 'hiring', ref: 'hiring:1', company: 'Summit PM', site: 'summit-tx.com' }),
      ev({ source: 'hiring', ref: 'hiring:2', company: 'Summit PM', site: 'summitpm.co' }),
      ev({ source: 'influencer', ref: 'influencer:3', company: 'Summit PM' }),
    ])
    expect(summits.map((r) => r.key).sort()).toEqual(['d:summit-tx.com', 'd:summitpm.co', 'n:summit pm'])
    const rows = applyState(summits, [state({ account_key: 'n:summit pm', status: 'replied', deal_id: 'deal-9', call_touched_at: '2026-11-26T18:00:00Z' })])
    const by = Object.fromEntries(rows.map((r) => [r.key, r]))
    // Only the account whose own key it is carries the state; the two domains stay new, each under its own key.
    expect(by['n:summit pm']).toMatchObject({ status: 'replied', deal_id: 'deal-9', state_key: 'n:summit pm' })
    expect(by['d:summit-tx.com']).toMatchObject({ status: 'new', deal_id: null, state_key: 'd:summit-tx.com' })
    expect(by['d:summitpm.co']).toMatchObject({ status: 'new', deal_id: null, state_key: 'd:summitpm.co' })
    expect(isUntouched(by['d:summit-tx.com'])).toBe(true)
  })

  it('nor when two domains carry the alias and no row owns it', () => {
    const two = mergeSignals([
      ev({ source: 'hiring', ref: 'hiring:1', company: 'Summit PM', site: 'summit-tx.com' }),
      ev({ source: 'hiring', ref: 'hiring:2', company: 'Summit PM', site: 'summitpm.co' }),
    ])
    const rows = applyState(two, [state({ account_key: 'n:summit pm', status: 'dropped' })])
    expect(rows.map((r) => [r.status, r.state_key === r.key])).toEqual([['new', true], ['new', true]])
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
  it('is a lowercase address on .invalid that names the kind and is stable per account', () => {
    expect(placeholderEmail('d:acme.com')).toMatch(/^d-acme-com-[a-z0-9]+@signal\.invalid$/)
    expect(placeholderEmail('n:blue door rentals')).toMatch(/^n-blue-door-rentals-[a-z0-9]+@signal\.invalid$/)
    expect(placeholderEmail('d:acme.com')).toBe(placeholderEmail('d:acme.com'))
    for (const key of ['d:acme.com', 'n:Blue Door', 'r:PM_Dave', 'n:недвижимость плюс', 'n:' + 'x'.repeat(190)]) {
      const e = placeholderEmail(key)
      expect(e, key).toBe(e.toLowerCase())
      expect(e.length, key).toBeLessThanOrEqual(320)
      expect(e, key).toMatch(/^[a-z0-9-]+@signal\.invalid$/)
    }
  })
  it('two accounts never share an address, even when their keys flatten to the same text', () => {
    const groups = [
      ['d:acme.com', 'n:acme com', 'r:acme_com', 'r:acme.com'],
      ['r:summit', 'n:summit'],
      ['n:недвижимость плюс', 'n:不動産管理', 'n:إدارة'],
      ['n:' + 'x'.repeat(190), 'n:' + 'x'.repeat(189) + 'y'],
    ]
    for (const keys of groups) expect(new Set(keys.map(placeholderEmail)).size, keys.join(' | ')).toBe(keys.length)
  })
})
