import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifyRole, cleanLinkedIn, companyDomain, countryOf, normCompany, normDomain } from '@/lib/hiring/normalize'

describe('classifyRole', () => {
  it.each([
    ['Leasing Coordinator', 'coordinator'],
    ['Maintenance Coordinator - Multifamily', 'coordinator'],
    ['Leasing Agent (Part-Time)', 'coordinator'],
    ['Leasing Consultant', 'coordinator'],
    ['Assistant Property Manager', 'coordinator'],
    ['Office Administrator', 'coordinator'],
    ['Office Admin / Receptionist', 'coordinator'],
    ['Resident Services Coordinator', 'coordinator'],
    ['APM - Single Family', 'coordinator'],
    ['COO', 'leadership'],
    ['Chief Operating Officer', 'leadership'],
    ['VP of Operations', 'leadership'],
    ['Vice President, Operations', 'leadership'],
    ['Director of Operations', 'leadership'],
    ['Head of Operations', 'leadership'],
    ['Director of Property Management', 'leadership'],
    ['Regional Property Manager', 'leadership'],
    ['Regional Manager', 'leadership'],
    ['Portfolio Manager', 'leadership'],
    ['Property Manager', 'leadership'],
    ['Senior Property Manager - HOA', 'leadership'],
  ])('%s → %s', (title, tier) => expect(classifyRole(title)).toBe(tier))

  it.each(['Software Engineer', 'Real Estate Agent', 'Maintenance Technician', 'Leasing Manager Trainee?', '', null])('%s → null', (title) => {
    expect(classifyRole(title as string | null)).toBeNull()
  })
})

describe('domains and names', () => {
  it('normDomain strips scheme, www, port, path; lowercases', () => {
    expect(normDomain('https://WWW.SunbeltPM.com/about?x=1')).toBe('sunbeltpm.com')
    expect(normDomain('sunbeltpm.com:8080')).toBe('sunbeltpm.com')
    expect(normDomain('http://maplehomes.ca')).toBe('maplehomes.ca')
    expect(normDomain('not a domain')).toBeNull()
    expect(normDomain('')).toBeNull()
    expect(normDomain(null)).toBeNull()
  })
  it('companyDomain drops free-mail and platform hosts', () => {
    expect(companyDomain('https://www.linkedin.com/company/x')).toBeNull()
    expect(companyDomain('gmail.com')).toBeNull()
    expect(companyDomain('https://acme.wixsite.com/pm')).toBeNull()
    expect(companyDomain('https://acme-pm.com')).toBe('acme-pm.com')
  })
  it('normCompany drops punctuation and legal suffixes', () => {
    expect(normCompany('Sunbelt Property Management, LLC')).toBe('sunbelt property management')
    expect(normCompany('Smith & Sons Realty Inc.')).toBe('smith and sons realty')
    expect(normCompany('  ')).toBeNull()
  })
  it('cleanLinkedIn drops tracking', () => {
    expect(cleanLinkedIn('https://www.linkedin.com/in/dana-ruiz-12ab?trk=x')).toBe('https://www.linkedin.com/in/dana-ruiz-12ab')
    expect(cleanLinkedIn('https://example.com')).toBeNull()
  })
  it('countryOf reads US / Canada', () => {
    expect(countryOf('Austin, TX')).toBe('US')
    expect(countryOf('Los Angeles, CA')).toBe('US')
    expect(countryOf('Toronto, Ontario, Canada')).toBe('CA')
    expect(countryOf('Vancouver, BC')).toBe('CA')
    expect(countryOf('Dallas-Fort Worth Metroplex Metropolitan Area')).toBe('US')
    expect(countryOf('London, England, United Kingdom')).toBeNull()
    expect(countryOf(null, 'ca')).toBe('CA')
  })
})

describe('SQL normalisers (exclusion RPC) mirror the TS ones', () => {
  const dir = new URL('../../../supabase/migrations/', import.meta.url)
  const file = readdirSync(dir).find((f) => /_lume_hiring_signal\.sql$/.test(f))!
  const sql = readFileSync(new URL(file, dir), 'utf8')
  it('domain: scheme, www, then anything from / : ? #', () => {
    expect(sql).toContain("'^[a-z][a-z0-9+.-]*://'")
    expect(sql).toContain("'^www\\.'")
    expect(sql).toContain("'[/:?#].*$'")
  })
  it('company: & → and, non-alnum → space, the same legal suffixes', () => {
    expect(sql).toContain("'&', ' and '")
    expect(sql).toContain("'\\m(inc|llc|ltd|corp|corporation|co|company|limited|lp|llp|pllc)\\M'")
  })
  it('the schedule is NOT in the main migration', () => {
    expect(sql).not.toMatch(/cron\.schedule/)
  })
})
