import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APOLLO_IMPORT_STEPS,
  estimateInfluencer,
  estimateRun,
  exportColumns,
  influencerApolloCsv,
  LAST_RUN,
  postsReserveUsd,
  reactionsMaxChargeUsd,
  splitLocation,
  splitName,
  type InfluencerRow,
  type ExportReactor,
} from '@/lib/influencers/model'

const inf = (o: Partial<InfluencerRow> = {}): InfluencerRow => ({
  id: 'i1', name: 'Peter Lohmann', slug: 'peter-lohmann', linkedin_url: 'https://www.linkedin.com/in/pslohmann',
  lookback_days: 90, max_reactions_per_post: 1000, active: true, notes: null, last_ran_at: '2026-10-07T12:00:00Z',
  last_posts: 317, last_top_posts: 10, last_reactions: 1114, last_reactors: 837, last_leads: 71, last_leads_700: 26,
  last_apify_usd: 2.31, last_perplexity_usd: 0.81, last_haiku_usd: 0.39, last_cost_usd: 3.51, ...o,
})

describe('last run benchmarks', () => {
  it('match the 2026-10-08 full run', () => {
    expect(LAST_RUN).toMatchObject({ influencers: 26, total_usd: 37, reactions: 13032, unique_reactors: 7638, candidates: 1957, verified: 254, with_door_count: 218, leads_700: 97 })
    expect(LAST_RUN.reactors_per_lead).toBe(30)
    expect(LAST_RUN.pct_700_of_verified).toBe(38)
  })
})

describe('Apify bounds (parity with supabase/functions/_shared/influencer/cost.ts)', () => {
  it('reserves the same amounts as the edge function', () => {
    expect(postsReserveUsd(317)).toBe(1.06)
    expect(postsReserveUsd(null)).toBe(1)
    expect(reactionsMaxChargeUsd(1.8)).toBe(2.03)
    expect(reactionsMaxChargeUsd(30)).toBe(20)
  })
  it('the edge function uses the same unit prices and formulas', () => {
    const src = readFileSync(join(__dirname, '../../../supabase/functions/_shared/influencer/cost.ts'), 'utf8')
    expect(src).toContain('PRICE_PER_1K_POSTS = 2')
    expect(src).toContain('PRICE_PER_1K_REACTIONS = 1.5')
    expect(src).toContain('Math.max(0, estimateUsd) * 1.1 + 0.05')
    expect(src).toContain(': Math.max(0, lastPosts)) * 1.5')
  })
})

describe('estimateInfluencer', () => {
  it('uses the influencer\'s own last-run numbers and rates', () => {
    const e = estimateInfluencer(inf())
    expect(e.basis).toBe('last_run')
    expect(e.posts).toBe(317)
    expect(e.posts_usd).toBe(0.63)
    expect(e.posts_reserve_usd).toBe(1.06)
    expect(e.reactions).toEqual({ low: 780, expected: 1114, high: 1448 })
    expect(e.reactions_usd).toEqual({ low: 1.17, expected: 1.67, high: 2.17 })
    // a re-run: between 30% and 100% of the reactors are new and need verifying
    expect(e.new_reactors).toEqual({ low: 251, high: 837 })
    expect(e.leads_per_reactor).toBeCloseTo(71 / 837, 5)
    expect(e.leads.high).toBe(71)
    expect(e.leads_700.high).toBe(26)
    expect(e.last_cost_usd).toBe(3.51)
  })
  it('caps the high end at 10 posts x the per-post cap', () => {
    expect(estimateInfluencer(inf({ max_reactions_per_post: 100, last_reactions: 974 })).reactions.high).toBe(1000)
  })
  it('a never-run influencer uses the full run\'s averages', () => {
    const e = estimateInfluencer(inf({ last_ran_at: null, last_posts: null, last_reactions: null, last_reactors: null, last_leads: null, last_leads_700: null, last_cost_usd: null }))
    expect(e.basis).toBe('benchmark')
    expect(e.posts).toBe(300)
    expect(e.reactions.expected).toBe(LAST_RUN.avg_reactions_per_influencer)
    expect(e.reactions.low).toBe(0)
    expect(e.new_reactors.low).toBe(e.new_reactors.high)
  })
  it('flags zero yield last run', () => {
    const e = estimateInfluencer(inf({ last_posts: 0, last_reactions: 0, last_reactors: 0, last_leads: 0, last_leads_700: 0, notes: 'Zero yield on 2026-10-08: no posts in the last 365 days.' }))
    expect(e.zero_yield).toBe(true)
    expect(e.warning).toMatch(/Zero yield/)
    expect(e.reactions.expected).toBe(0)
  })
})

describe('estimateRun', () => {
  it('posts cost now, reactions and Perplexity ranges, Perplexity capped', () => {
    const r = estimateRun([inf(), inf({ id: 'i2', slug: 'deb-newell', name: 'Deb Newell', last_posts: 42, last_reactions: 444, last_reactors: 295, last_leads: 25, last_leads_700: 9, last_cost_usd: 1.08 })], { maxVerifyUsd: 10 })
    expect(r.influencers).toBe(2)
    expect(r.posts_usd_now).toBe(0.72)
    expect(r.posts_reserve_usd).toBe(1.29)
    expect(r.reactions_usd).toEqual({ low: 1.64, expected: 2.34, high: 3.04 })
    expect(r.perplexity_usd.high).toBeGreaterThan(r.perplexity_usd.low)
    expect(r.perplexity_usd.high).toBeLessThanOrEqual(10)
    expect(r.last_run_cost_usd).toBe(4.59)
    expect(r.approvals).toHaveLength(2)
    const tight = estimateRun([inf()], { maxVerifyUsd: 0.1 })
    expect(tight.perplexity_usd.high).toBe(0.1)
    expect(tight.perplexity_capped).toBe(true)
  })
})

describe('names and locations', () => {
  it('splits names, dropping credentials and parentheses', () => {
    expect(splitName('Brad Randall, CPM')).toEqual({ first: 'Brad', last: 'Randall' })
    expect(splitName('Jennifer Ruelens (PM Jen)')).toEqual({ first: 'Jennifer', last: 'Ruelens' })
    expect(splitName('Mary Ann van der Berg')).toEqual({ first: 'Mary', last: 'Ann van der Berg' })
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: '' })
    expect(splitName(null)).toEqual({ first: '', last: '' })
  })
  it('splits locations; a US state implies United States', () => {
    expect(splitLocation('Ogden, Utah')).toEqual({ city: 'Ogden', state: 'Utah', country: 'United States' })
    expect(splitLocation('Austin, TX')).toEqual({ city: 'Austin', state: 'TX', country: 'United States' })
    expect(splitLocation('Toronto, Ontario, Canada')).toEqual({ city: 'Toronto', state: 'Ontario', country: 'Canada' })
    expect(splitLocation('Ohio')).toEqual({ city: '', state: 'Ohio', country: 'United States' })
    expect(splitLocation('London')).toEqual({ city: 'London', state: '', country: '' })
    expect(splitLocation('')).toEqual({ city: '', state: '', country: '' })
  })
})

const reactor = (o: Partial<ExportReactor> = {}): ExportReactor => ({
  id: 1, name: 'Brad Randall, CPM', linkedin_url: 'https://www.linkedin.com/in/ACoAAADV', title: 'Owner',
  company_name: 'Welch Randall Real Estate & Property Management', company_website: 'https://www.welchrandall.com/',
  location: 'Ogden, Utah', city: null, state: null, country: null, door_count: 450,
  reacted_to: ['jordan-muela', 'deb-newell'], ...o,
})

describe('influencerApolloCsv', () => {
  const names = { 'jordan-muela': 'Jordan Muela', 'deb-newell': 'Deb Newell' }
  it('Apollo contact-import columns, Website = the company domain', () => {
    const { csv, rows } = influencerApolloCsv([reactor()], { names })
    const [head, line] = csv.trimEnd().split('\n')
    expect(head).toBe('First Name,Last Name,Title,Company,Website,Person Linkedin Url,City,State,Country')
    expect(line).toBe('Brad,Randall,Owner,Welch Randall Real Estate & Property Management,welchrandall.com,https://www.linkedin.com/in/ACoAAADV,Ogden,Utah,United States')
    expect(rows).toBe(1)
  })
  it('optional custom columns Door Count and Reacted To', () => {
    expect(exportColumns({ doorCount: true, reactedTo: true }).slice(-2)).toEqual(['Door Count', 'Reacted To'])
    const { csv } = influencerApolloCsv([reactor({ door_count: null })], { names, doorCount: true, reactedTo: true })
    expect(csv.trimEnd().split('\n')[1].endsWith(',,Jordan Muela; Deb Newell')).toBe(true)
  })
  it('stored city/state/country win over the parsed location', () => {
    const { csv } = influencerApolloCsv([reactor({ city: 'Layton', state: 'UT', country: 'United States' })], { names })
    expect(csv).toContain(',Layton,UT,United States')
  })
  it('escapes quotes, commas and newlines, and neutralises spreadsheet formulas', () => {
    const { csv } = influencerApolloCsv([reactor({ title: 'CEO, "Founder"\nand owner', company_name: '=HYPERLINK("x")' })], { names })
    const line = csv.trimEnd().split('\n')[1]
    expect(line).toContain('"CEO, ""Founder"" and owner"')
    expect(line).toContain(`"'=HYPERLINK(""x"")"`)
    expect(csv.trimEnd().split('\n')).toHaveLength(2)
  })
  it('the Apollo steps end with the search link pasted back to Lume for a Leadsfriday order', () => {
    expect(APOLLO_IMPORT_STEPS.join(' ')).toMatch(/Import/)
    expect(APOLLO_IMPORT_STEPS.at(-1)).toMatch(/create_order|Leadsfriday/)
  })
})
