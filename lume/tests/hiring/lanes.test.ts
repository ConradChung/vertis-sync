import { describe, expect, it } from 'vitest'
import {
  ACTORS,
  articleCandidate,
  buildExpansionInputs,
  buildHiringInput,
  buildNewManagerInput,
  normalizeArticle,
  normalizeJob,
  normalizePerson,
  uniqueByKey,
} from '@/lib/hiring/lanes'
import { ARTICLE, JOB_ABROAD, JOB_COORDINATOR, JOB_LEADERSHIP, JOB_OFF_TARGET, PROFILE_NEW, PROFILE_OLD } from './fixtures'

const REGIONS = ['United States', 'Canada']

describe('hiring lane (curious_coder/linkedin-jobs-scraper)', () => {
  it('input: one past-24h search URL per title group x region, company details on', () => {
    const li = buildHiringInput(REGIONS)
    expect(ACTORS.hiring).toBe('curious_coder/linkedin-jobs-scraper')
    const urls = li.input.urls as string[]
    expect(urls).toHaveLength(4)
    for (const u of urls) {
      const p = new URL(u).searchParams
      expect(p.get('f_TPR')).toBe('r86400')
      expect(p.get('keywords')).toContain('"property management"')
      expect(REGIONS).toContain(p.get('location'))
    }
    expect(new URL(urls[0]).searchParams.get('keywords')).toContain('"Director of Property Management"')
    expect(new URL(urls[2]).searchParams.get('keywords')).toContain('"Leasing Coordinator"')
    expect(li.input).toMatchObject({ scrapeCompany: true, limitPerSource: 50 })
    expect(li.maxItems).toBe(200)
  })
  it('manual max_items splits across the searches', () => {
    const li = buildHiringInput(REGIONS, 25)
    expect(li.input.limitPerSource).toBe(7)
    expect(li.maxItems).toBe(25)
  })
  it('normalises a coordinator ad with its poster, website and company LinkedIn', () => {
    const c = normalizeJob(JOB_COORDINATOR)!
    expect(c).toMatchObject({
      dedupe_key: 'job:4012345678',
      signal: 'hiring',
      role_tier: 'coordinator',
      role_title: 'Leasing Coordinator',
      source_url: 'https://www.linkedin.com/jobs/view/leasing-coordinator-at-sunbelt-property-management-4012345678',
      location: 'Austin, TX',
      country: 'US',
      company_name: 'Sunbelt Property Management, LLC',
      company_domain: 'sunbeltpm.com',
      company_website: 'https://www.sunbeltpm.com/about',
      company_linkedin: 'https://www.linkedin.com/company/sunbelt-pm',
      person_name: 'Dana Ruiz',
      person_linkedin: 'https://www.linkedin.com/in/dana-ruiz-12ab',
      posted_at: '2026-11-22T00:00:00.000Z',
    })
    expect(JSON.stringify(c.raw)).not.toContain('descriptionText')
  })
  it('leadership in Canada without a poster', () => {
    expect(normalizeJob(JOB_LEADERSHIP)).toMatchObject({ role_tier: 'leadership', country: 'CA', company_domain: 'maplehomes.ca', person_name: null, person_linkedin: null })
  })
  it('drops off-target titles and jobs outside the US / Canada', () => {
    expect(normalizeJob(JOB_OFF_TARGET)).toBeNull()
    expect(normalizeJob(JOB_ABROAD)).toBeNull()
    expect(normalizeJob({ title: 'Leasing Agent' })).toBeNull()
  })
  it('dedupes by job id', () => {
    const cs = [JOB_COORDINATOR, JOB_COORDINATOR, JOB_LEADERSHIP].map(normalizeJob).filter((x) => x !== null)
    expect(uniqueByKey(cs).map((c) => c.dedupe_key)).toEqual(['job:4012345678', 'job:4012345679'])
  })
})

describe('new_manager lane (harvestapi/linkedin-profile-search)', () => {
  const now = new Date('2026-11-23T12:00:00Z')
  it('input: ops-leader titles, recently changed jobs, PM industries and headcount, US + Canada', () => {
    const li = buildNewManagerInput(REGIONS)
    expect(li.input).toMatchObject({
      recentlyChangedJobs: true,
      industryIds: ['44', '1759', '128'],
      companyHeadcount: ['C', 'D', 'E', 'F', 'G'],
      locations: REGIONS,
      profileScraperMode: 'Full',
      maxItems: 50,
    })
    expect(li.input.currentJobTitles).toContain('Director of Operations')
  })
  it('keeps a current ops-leader role started in the last 90 days', () => {
    expect(normalizePerson(PROFILE_NEW, now)).toMatchObject({
      dedupe_key: 'person:https://www.linkedin.com/in/pat-lee',
      signal: 'new_manager',
      role_tier: 'leadership',
      role_title: 'VP of Operations',
      company_name: 'Harbor Residential',
      company_linkedin: 'https://www.linkedin.com/company/harbor-residential',
      person_name: 'Pat Lee',
      country: 'US',
      posted_at: '2026-10-01T00:00:00.000Z',
    })
  })
  it('drops roles started more than 90 days ago', () => {
    expect(normalizePerson(PROFILE_OLD, now)).toBeNull()
  })
})

describe('expansion lane (lhotanova/google-news-scraper)', () => {
  it('input: one run per edition, last day, publisher URLs on, page loads off', () => {
    const ins = buildExpansionInputs(REGIONS)
    expect(ins.map((i) => i.variant)).toEqual(['US:en', 'CA:en'])
    expect(ins[0].input).toMatchObject({ language: 'US:en', openEndedDateRange: '1d', fetchArticleDetails: true, fetchArticlePage: false, maxItems: 40 })
    expect(ins[0].input.query).toContain('"property management"')
  })
  it('article → candidate after a relevant extraction; irrelevant dropped', () => {
    const a = normalizeArticle(ARTICLE, 'US:en')!
    expect(a.url).toBe('https://www.businesswire.com/news/home/2026112200/en/evernest-acquires')
    const c = articleCandidate(a, { relevant: true, company_name: 'Evernest', domain: 'evernest.co', event_type: 'acquisition', summary: 'Evernest bought Keyrenter Columbus.' })!
    expect(c).toMatchObject({ signal: 'expansion', dedupe_key: `news:${a.url}|evernest`, company_domain: 'evernest.co', headline: 'Evernest bought Keyrenter Columbus.', country: 'US', role_title: 'acquisition' })
    expect(articleCandidate(a, { relevant: false, company_name: 'X', domain: '', event_type: 'funding', summary: '' })).toBeNull()
    expect(articleCandidate(a, { relevant: true, company_name: 'X', domain: '', event_type: 'other', summary: '' })).toBeNull()
  })
})
