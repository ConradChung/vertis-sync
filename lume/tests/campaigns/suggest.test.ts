import { describe, expect, it } from 'vitest'
import {
  headerRole,
  noLocationAdvice,
  pickSettings,
  profileLeads,
  profileSimilarity,
  rankTemplatesFor,
  roleOf,
  scoreVerticals,
  segmentOf,
  sequencePreview,
  suggestCampaign,
  suggestName,
  usesLocation,
  type CampaignSetup,
  type LeadRow,
  type VerticalInput,
} from '@/lib/campaigns/suggest'

const KASPEN = 'aaaaaaaa-0000-4000-8000-000000000001'
const JOBS = 'aaaaaaaa-0000-4000-8000-000000000002'
const HNWI = 'aaaaaaaa-0000-4000-8000-000000000003'
const ROOF = 'aaaaaaaa-0000-4000-8000-000000000004'

const VERTICALS: VerticalInput[] = [
  { id: KASPEN, name: 'Kaspen / Zenport', keywords: ['property management', 'property manager', 'real estate', 'leasing', 'hoa', 'apartments', 'doors', 'rental'] },
  { id: JOBS, name: 'Job search / GTM roles', keywords: ['hiring', 'account executive', 'sdr', 'gtm', 'recruiting', 'recruiter'] },
  { id: HNWI, name: 'HNWI / wealth management', keywords: ['wealth', 'family office', 'insider', 'form 4', 'private equity'] },
  { id: ROOF, name: 'Roofers', keywords: ['roofing', 'roofer', 'contractor'] },
]

function pmRows(n: number, opts: { cityEvery?: number } = {}): LeadRow[] {
  return Array.from({ length: n }, (_, i) => ({
    'First Name': `A${i}`,
    Title: i % 5 === 0 ? 'Property Manager' : 'Owner',
    Industry: i % 3 === 0 ? 'Real Estate' : 'property management',
    Keywords: 'residential property management, leasing, hoa',
    'Company Name': `Acme Property Group ${i}`,
    City: opts.cityEvery && i % opts.cityEvery === 0 ? '' : 'Austin',
    State: 'Texas',
    '# Employees': '12',
  }))
}

const jobRows: LeadRow[] = Array.from({ length: 40 }, (_, i) => ({
  'job_title': i % 2 ? 'Account Executive' : 'Founding SDR',
  'company.industry': 'Computer Software',
  'company.name': `Startup ${i}`,
  '_metadata.search_term': 'GTM hiring',
  'profile.location.city': 'San Francisco',
}))

describe('headerRole', () => {
  it('reads CSV and dotted lead-list headers case-insensitively', () => {
    expect(headerRole('Industry')).toBe('industry')
    expect(headerRole('company.industry')).toBe('industry')
    expect(headerRole('TITLE')).toBe('title')
    expect(headerRole('profile.title')).toBe('title')
    expect(headerRole('author.headline')).toBe('title')
    expect(headerRole('article.title')).toBeNull()
    expect(headerRole('Keywords')).toBe('keywords')
    expect(headerRole('_metadata.search_term')).toBe('keywords')
    expect(headerRole('Company Name')).toBe('company')
    expect(headerRole('company.name')).toBe('company')
    expect(headerRole('operating_city')).toBe('city')
    expect(headerRole('Company City')).toBe('city')
    expect(headerRole('State')).toBe('region')
    expect(headerRole('Email')).toBeNull()
  })
})

describe('profileLeads', () => {
  it('top industries / titles / keywords / roles / locations from whichever columns exist', () => {
    const p = profileLeads(pmRows(100, { cityEvery: 4 }))
    expect(p.rows).toBe(100)
    expect(p.industries[0]).toMatchObject({ value: 'property management' })
    expect(p.titles[0]).toMatchObject({ value: 'owner', n: 80 })
    expect(p.roles[0]).toMatchObject({ value: 'owner', share: 0.8 })
    expect(p.keywords.map((k) => k.value)).toEqual(expect.arrayContaining(['leasing', 'hoa']))
    expect(p.locations[0]).toMatchObject({ value: 'Texas', n: 100 })
    expect(p.without_city).toBe(25)
  })

  it('samples at most 500 rows', () => {
    expect(profileLeads(pmRows(700)).rows).toBe(500)
  })

  it('no city column → without_city null', () => {
    expect(profileLeads([{ Title: 'Owner' }]).without_city).toBeNull()
  })

  it('roleOf: owner beats manager in "Owner & Property Manager"', () => {
    expect(roleOf('Owner & Property Manager')).toBe('owner')
    expect(roleOf('Co-Founder & CEO')).toBe('founder')
    expect(roleOf('Leasing agent')).toBeNull()
  })
})

describe('scoreVerticals', () => {
  it('a property-management-heavy sample → Kaspen / Zenport first, with a why', () => {
    const ranked = scoreVerticals(profileLeads(pmRows(100)), VERTICALS)
    expect(ranked[0].id).toBe(KASPEN)
    expect(ranked[0].coverage).toBe(1)
    expect(ranked[0].source).toBe('keywords')
    expect(ranked[0].why).toMatch(/^\d+% of (industries|titles|keyword lists) mention /)
    expect(ranked[1].score).toBeLessThan(0.1)
  })

  it('a job-search sample → Job search / GTM roles', () => {
    const ranked = scoreVerticals(profileLeads(jobRows), VERTICALS)
    expect(ranked[0].id).toBe(JOBS)
    expect(ranked[0].why).toMatch(/mention (account executive|sdr|gtm|hiring)/)
  })

  it('an item already tagged wins, whatever the keywords say', () => {
    const ranked = scoreVerticals(profileLeads(pmRows(50)), VERTICALS, { taggedVerticalId: ROOF })
    expect(ranked[0]).toMatchObject({ id: ROOF, source: 'tagged', score: 2 })
    expect(ranked[0].why).toMatch(/^Already tagged Roofers/)
    expect(ranked[1].id).toBe(KASPEN)
  })

  it('history: a tag whose past lists look like this one gets the bonus and the why', () => {
    const generic: LeadRow[] = Array.from({ length: 20 }, () => ({ Title: 'Office Admin', Industry: 'Facilities Services' }))
    const p = profileLeads(generic)
    const ranked = scoreVerticals(p, VERTICALS, { history: [{ vertical_id: ROOF, profile: profileLeads(generic) }] })
    expect(profileSimilarity(p, p)).toBeCloseTo(1)
    expect(ranked[0]).toMatchObject({ id: ROOF, source: 'history' })
    expect(ranked[0].why).toMatch(/Looks like earlier Roofers lists/)
  })
})

const TEMPLATES = [
  { id: 't-zen', name: 'Zenport Campaign', vertical_id: KASPEN, sequences: [{ steps: [{ variants: [{ subject: 'Owners in {{location}}', body: '<div>Hey {{firstName}},</div><div>800 doors</div>' }] }, { variants: [{ subject: '', body: 'bump' }] }] }] },
  { id: 't-zen-nl', name: 'Zenport Campaign — No Location', vertical_id: KASPEN, sequences: [{ steps: [{ variants: [{ subject: 'Owners', body: 'x' }] }] }] },
  { id: 't-gtm', name: 'GTM roles outreach', vertical_id: null, sequences: [{ steps: [{ variants: [{ subject: 'Hiring?', body: 'y' }] }] }] },
]

describe('templates', () => {
  it("the tag's own templates first, its No-Location one after the main", () => {
    const r = rankTemplatesFor(TEMPLATES, { id: KASPEN, name: 'Kaspen / Zenport' })
    expect(r.map((t) => t.id)).toEqual(['t-zen', 't-zen-nl', 't-gtm'])
    expect(r[0]).toMatchObject({ why: 'Tagged Kaspen / Zenport', uses_location: true, no_location: false })
    expect(r[1]).toMatchObject({ no_location: true, uses_location: false })
  })

  it('then by name similarity to the tag', () => {
    const r = rankTemplatesFor(TEMPLATES, { id: JOBS, name: 'Job search / GTM roles' })
    expect(r[0]).toMatchObject({ id: 't-gtm', why: 'Name matches Job search / GTM roles' })
  })

  it('usesLocation / sequencePreview', () => {
    expect(usesLocation(TEMPLATES[0].sequences)).toBe(true)
    expect(usesLocation(TEMPLATES[2].sequences)).toBe(false)
    expect(sequencePreview(TEMPLATES[0].sequences)).toEqual({ steps: 2, variants: 1, subject: 'Owners in {{location}}', body: 'Hey {{firstName}},\n800 doors' })
    expect(sequencePreview([])).toBeNull()
  })
})

describe('name', () => {
  const now = new Date('2026-11-09T12:00:00Z')
  it('"<Tag short> — <segment> — <Mon YYYY>"', () => {
    expect(segmentOf(profileLeads(pmRows(100)))).toBe('PM owners')
    expect(suggestName({ verticalName: 'Kaspen / Zenport', segment: 'PM owners', now })).toBe('Kaspen — PM owners — Nov 2026')
    expect(suggestName({ verticalName: null, segment: null, now })).toBe('New campaign — Nov 2026')
  })
  it('unique against existing campaign names', () => {
    expect(suggestName({ verticalName: 'Roofers', segment: null, now, existing: ['roofers — Nov 2026', 'Roofers — Nov 2026 (2)'] })).toBe('Roofers — Nov 2026 (3)')
  })
})

const camp = (id: string, created: string, emails = ['a@x.com']): CampaignSetup => ({
  id,
  name: `Camp ${id}`,
  created_at: created,
  email_list: emails,
  campaign_schedule: { schedules: [] },
  daily_limit: 40,
  stop_on_reply: true,
})

describe('settings + no-location', () => {
  const campaigns = [camp('old-k', '2026-09-01T00:00:00Z', ['k@x.com']), camp('newest', '2026-11-01T00:00:00Z'), camp('empty', '2026-11-05T00:00:00Z', [])]
  it("the tag's most recent campaign with inboxes", () => {
    expect(pickSettings(campaigns, new Set(['old-k']), 'Kaspen / Zenport')).toMatchObject({ source_campaign_id: 'old-k', email_list: ['k@x.com'], why: 'Copied from Camp old-k, the latest Kaspen / Zenport campaign' })
  })
  it('else the most recent campaign overall', () => {
    expect(pickSettings(campaigns, new Set(), 'Roofers')).toMatchObject({ source_campaign_id: 'newest', why: expect.stringContaining('no Roofers campaign yet') })
    expect(pickSettings([], new Set(), null)).toBeNull()
  })
  it('advises a No-Location sibling only when ≥ 10% lack a city and the copy uses {{location}}', () => {
    expect(noLocationAdvice({ rows: 100, without_city: 25 }, true)).toMatchObject({ advisable: true, share: 0.25 })
    expect(noLocationAdvice({ rows: 100, without_city: 25 }, false)).toMatchObject({ advisable: false, why: 'The template never uses {{location}}' })
    expect(noLocationAdvice({ rows: 100, without_city: 5 }, true)).toMatchObject({ advisable: false })
    expect(noLocationAdvice({ rows: 100, without_city: null }, true)).toMatchObject({ advisable: false, share: null })
  })
})

describe('suggestCampaign', () => {
  it('PM leads → Kaspen tag, Zenport template, PM name, Kaspen settings, No-Location advice', () => {
    const profile = profileLeads(pmRows(100, { cityEvery: 4 }))
    const s = suggestCampaign({
      profile,
      ranked: scoreVerticals(profile, VERTICALS),
      templates: TEMPLATES,
      campaigns: [camp('k1', '2026-10-01T00:00:00Z', ['k@x.com']), camp('other', '2026-11-01T00:00:00Z')],
      verticalCampaigns: new Map([[KASPEN, new Set(['k1'])]]),
      now: new Date('2026-11-09T00:00:00Z'),
    })
    expect(s).toMatchObject({
      vertical_id: KASPEN,
      template_id: 't-zen',
      name: 'Kaspen — PM owners — Nov 2026',
      settings: { source_campaign_id: 'k1' },
      no_location: { advisable: true },
      no_location_template_id: 't-zen-nl',
    })
  })

  it("never pre-selects another tag's template", () => {
    const profile = profileLeads(jobRows)
    const s = suggestCampaign({ profile, ranked: scoreVerticals(profile, VERTICALS), templates: TEMPLATES.slice(0, 2), campaigns: [], verticalCampaigns: new Map(), now: new Date('2026-11-09T00:00:00Z') })
    expect(s.vertical_id).toBe(JOBS)
    expect(s.template_id).toBeNull()
    expect(s.template_why).toBe('No template for this tag yet — pick one')
  })

  it('nothing fits → no tag, generic name', () => {
    const profile = profileLeads([{ Title: 'Chef', Industry: 'Restaurants' }])
    const s = suggestCampaign({ profile, ranked: scoreVerticals(profile, VERTICALS), templates: [], campaigns: [], verticalCampaigns: new Map(), now: new Date('2026-11-09T00:00:00Z') })
    expect(s.vertical_id).toBeNull()
    expect(s.vertical_why).toMatch(/^No tag clearly fits/)
    expect(s.name).toBe('New campaign — Restaurants — Nov 2026')
    expect(s.settings).toBeNull()
  })
})
