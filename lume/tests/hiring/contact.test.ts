import { describe, expect, it, vi } from 'vitest'
import { findHiringContact, type ContactBlitz } from '@/lib/hiring/contact'
import { runHiringTick } from '@/lib/hiring/engine'
import { JOB_COORDINATOR, JOB_LEADERSHIP } from './fixtures'
import { deps, fakeAi, fakeApify, memoryStore } from './memoryStore'

const NOW = new Date('2026-11-23T20:00:00Z')
const LATER = new Date('2026-11-23T20:30:00Z')

function fakeBlitz(over: Partial<ContactBlitz> = {}, records = 100) {
  let left = records
  const b = {
    recordsUsed: 0,
    canSpend: vi.fn(async (cost = 1) => left >= cost),
    findWorkEmail: vi.fn(async (url: string) => {
      left--
      b.recordsUsed++
      return { kind: 'found' as const, email: url.includes('dana') ? 'dana@sunbeltpm.com' : 'owner@maplehomes.ca' }
    }),
    domainToLinkedin: vi.fn(async () => {
      left--
      b.recordsUsed++
      return { kind: 'found' as const, companyLinkedinUrl: 'https://www.linkedin.com/company/acme', companyName: 'Acme' }
    }),
    waterfallIcp: vi.fn(async () => {
      left--
      b.recordsUsed++
      return { kind: 'found' as const, people: [{ name: 'Olive Owner', firstName: 'Olive', lastName: 'Owner', title: 'Owner', linkedinUrl: 'https://www.linkedin.com/in/olive', tier: 1 }] }
    }),
    ...over,
  }
  return b
}

const row = (o: Partial<Parameters<typeof findHiringContact>[1]> = {}) => ({
  company_domain: 'acme.com', company_website: null, company_linkedin: null, person_name: null, person_title: null, person_linkedin: null, ...o,
})

describe('findHiringContact', () => {
  it('named person with a profile → their work email only (1 record, no company search)', async () => {
    const b = fakeBlitz()
    const r = await findHiringContact(b, row({ person_name: 'Dana Ruiz', person_title: 'Director', person_linkedin: 'https://www.linkedin.com/in/dana-ruiz' }))
    expect(r).toEqual({ kind: 'found', contact: { contact_name: 'Dana Ruiz', contact_title: 'Director', contact_linkedin: 'https://www.linkedin.com/in/dana-ruiz', contact_email: 'dana@sunbeltpm.com', contact_source: 'person' } })
    expect(b.waterfallIcp).not.toHaveBeenCalled()
    expect(b.domainToLinkedin).not.toHaveBeenCalled()
  })

  it('company only → domain to LinkedIn, ONE decision-maker in the owner title order, then email', async () => {
    const b = fakeBlitz()
    const r = await findHiringContact(b, row())
    expect(r).toEqual({ kind: 'found', contact: { contact_name: 'Olive Owner', contact_title: 'Owner', contact_linkedin: 'https://www.linkedin.com/in/olive', contact_email: 'owner@maplehomes.ca', contact_source: 'waterfall' } })
    expect(b.domainToLinkedin).toHaveBeenCalledWith('acme.com')
    const [company, cascade, max] = vi.mocked(b.waterfallIcp).mock.calls[0] as unknown as [string, { include_title: string[] }[], number]
    expect(company).toBe('https://www.linkedin.com/company/acme')
    expect(max).toBe(1)
    expect(cascade[0].include_title).toEqual(expect.arrayContaining(['Owner', 'Principal', 'Founder', 'Managing Partner', 'President', 'CEO']))
    expect(cascade[1].include_title).toEqual(expect.arrayContaining(['COO', 'Head of Operations', 'Head of Asset Management']))
    expect(cascade[2].include_title).toEqual(expect.arrayContaining(['VP Property Management', 'Director of Property Management']))
    expect(b.recordsUsed).toBe(3)
  })

  it('company LinkedIn already on the row → no domain lookup (2 records at most)', async () => {
    const b = fakeBlitz()
    await findHiringContact(b, row({ company_linkedin: 'https://www.linkedin.com/company/maple-homes-pm' }))
    expect(b.domainToLinkedin).not.toHaveBeenCalled()
    expect(b.canSpend).toHaveBeenCalledWith(2)
  })

  it('fewer records left than the company path needs → nothing is called', async () => {
    const b = fakeBlitz({}, 2)
    expect(await findHiringContact(b, row())).toEqual({ kind: 'unavailable', reason: 'exhausted' })
    expect(b.domainToLinkedin).not.toHaveBeenCalled()
  })

  it('no decision-maker found → miss; Blitz unavailable → unavailable (never throws)', async () => {
    expect(await findHiringContact(fakeBlitz({ waterfallIcp: vi.fn(async () => ({ kind: 'miss' as const })) }), row())).toEqual({ kind: 'miss' })
    expect(await findHiringContact(fakeBlitz({ domainToLinkedin: vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'timeout' as const })) }), row())).toEqual({ kind: 'unavailable', reason: 'timeout' })
    expect(await findHiringContact(fakeBlitz(), row({ company_domain: null }))).toEqual({ kind: 'miss' })
  })
})

describe('runHiringTick with Blitz', () => {
  async function run(blitz: ReturnType<typeof fakeBlitz> | null, setup?: (m: ReturnType<typeof memoryStore>) => void) {
    const m = memoryStore()
    setup?.(m)
    const apify = fakeApify({ ds_apr1: [JOB_COORDINATOR, JOB_LEADERSHIP] })
    const ai = fakeAi()
    const d = () => ({ ...deps(m, apify, ai), blitz: blitz ? () => blitz : undefined })
    await runHiringTick(NOW, null, d())
    apify.status.apr1 = { status: 'SUCCEEDED', usageTotalUsd: 0.2 }
    m.setNow(LATER.toISOString())
    const t = await runHiringTick(LATER, null, d())
    return { m, t }
  }

  it('shown rows get one contact each: the poster by profile, the company-only row by waterfall (its LinkedIn page, no domain call)', async () => {
    const b = fakeBlitz()
    const { m, t } = await run(b)
    expect(t.processed.shown).toBe(2)
    const coord = m.rows.find((r) => r.role_tier === 'coordinator')!
    const lead = m.rows.find((r) => r.role_tier === 'leadership')!
    expect(coord).toMatchObject({ contact_source: 'person', contact_email: 'dana@sunbeltpm.com', person_name: 'Dana Ruiz' })
    expect(lead).toMatchObject({ contact_source: 'waterfall', contact_name: 'Olive Owner', contact_email: 'owner@maplehomes.ca' })
    expect(b.domainToLinkedin).not.toHaveBeenCalled()
    expect(t.contacts).toEqual({ found: 2, emails: 2, miss: 0, unavailable: 0, records_used: 3 })
    // Drafts are written from the row's own person fields, unchanged by the lookup.
    expect(lead.person_name ?? null).toBeNull()
  })

  it('companies in the lead bank / Instantly are skipped before any Blitz call', async () => {
    const b = fakeBlitz()
    const { m } = await run(b, (m) => m.setLead({ domains: new Map([['sunbeltpm.com', 'in_lead_bank']]), names: new Map([['maple homes', 'in_campaign'], ['maple homes property management', 'in_campaign']]) }))
    const skipped = m.rows.filter((r) => r.skip_reason)
    expect(skipped.length).toBeGreaterThan(0)
    for (const r of skipped) expect(r.contact_source ?? null).toBeNull()
    expect(vi.mocked(b.findWorkEmail).mock.calls.length + vi.mocked(b.waterfallIcp).mock.calls.length).toBe(m.rows.filter((r) => !r.skip_reason).length)
  })

  it('no BLITZ_API_KEY (no session) → rows ship exactly as before, no contacts tally', async () => {
    const { m, t } = await run(null)
    expect(t.processed.shown).toBe(2)
    expect(t.contacts).toBeUndefined()
    expect(m.rows.every((r) => r.contact_source === undefined)).toBe(true)
  })

  it('Blitz out of records → rows still ship, without a contact', async () => {
    const { m, t } = await run(fakeBlitz({}, 0))
    expect(t.processed.shown).toBe(2)
    expect(t.contacts).toMatchObject({ found: 0, unavailable: 2 })
    expect(m.rows.every((r) => !r.contact_email)).toBe(true)
  })
})
