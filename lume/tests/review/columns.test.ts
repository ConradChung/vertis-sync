import { describe, expect, it } from 'vitest'
import { leadColumnMapping, mappedRecord, rowRecord, UnknownColumnError } from '@/lib/review/columns'
import { normaliseLead } from '@/lib/review/model'

describe('leadColumnMapping', () => {
  it('maps a typical lead list, "Title" as the job title, and keeps the rest unmapped', () => {
    const header = ['Full Name', 'Title', 'Company', 'Website', 'Work E-mail', 'Mobile', 'LinkedIn URL', 'City', 'State', 'Country', 'Notes']
    const { mapping, unmapped } = leadColumnMapping(header)
    expect(mapping).toEqual({
      full_name: 'Full Name',
      title: 'Title',
      company: 'Company',
      website: 'Website',
      email: 'Work E-mail',
      phone: 'Mobile',
      linkedin_url: 'LinkedIn URL',
      city: 'City',
      state: 'State',
      country: 'Country',
    })
    expect(unmapped).toEqual(['Notes'])
  })
  it('first / last names and domain', () => {
    expect(leadColumnMapping(['first_name', 'LAST NAME', 'Company Domain']).mapping).toEqual({ first_name: 'first_name', last_name: 'LAST NAME', website: 'Company Domain' })
  })
  it('overrides win (case-insensitive header match) and an unknown header throws', () => {
    const { mapping } = leadColumnMapping(['Contact Name', 'Addr'], { email: 'addr' })
    expect(mapping).toEqual({ email: 'Addr', full_name: 'Contact Name' })
    expect(() => leadColumnMapping(['A'], { email: 'Nope' })).toThrow(UnknownColumnError)
  })
})

describe('content sniffing and tighter aliases', () => {
  it('a column of linkedin.com URLs is the LinkedIn field, even when it is called URL or Website', () => {
    const rows = [['Ann', 'Acme', 'https://www.linkedin.com/in/ann', 'acme.com'], ['Bo', 'B Co', 'linkedin.com/in/bo', 'b.co'], ['Cy', 'C', '', 'c.io']]
    expect(leadColumnMapping(['Name', 'Company', 'URL', 'Site'], {}, rows).mapping).toMatchObject({ linkedin_url: 'URL', website: 'Site' })
    expect(leadColumnMapping(['Name', 'Website'], {}, [['Ann', 'https://linkedin.com/in/ann']]).mapping).toEqual({ full_name: 'Name', linkedin_url: 'Website' })
    // Without LinkedIn values, URL stays the website.
    expect(leadColumnMapping(['URL'], {}, [['acme.com']]).mapping).toEqual({ website: 'URL' })
  })
  it('a bare "Contact" column is not taken as a name (it is often an email or phone)', () => {
    expect(leadColumnMapping(['Contact']).mapping).toEqual({})
    expect(leadColumnMapping(['Contact Person']).mapping).toEqual({ full_name: 'Contact Person' })
  })
})

describe('mapped rows → review items', () => {
  it('normalises through the same normaliseLead as actor results, with every column kept in raw', () => {
    const header = ['Name', 'Title', 'Company', 'Site', 'Email', 'Phone', 'LinkedIn', 'City', 'State', 'Country', 'Deal size']
    const row = ['Ann Lee', 'VP Sales', 'Acme Inc', 'https://www.acme.com/about', 'ann@acme.com', '+1 555 0100', 'https://linkedin.com/in/ann', 'Austin', 'TX', 'US', '50k']
    const { mapping } = leadColumnMapping(header)
    const raw = rowRecord(header, row)
    expect(raw['Deal size']).toBe('50k')
    const item = normaliseLead(mappedRecord(raw, mapping))
    expect(item).toMatchObject({
      name: 'Acme Inc',
      company: 'Acme Inc',
      first_name: 'Ann',
      last_name: 'Lee',
      title: 'VP Sales',
      website: 'https://www.acme.com/about',
      domain: 'acme.com',
      email: 'ann@acme.com',
      phone: '+1 555 0100',
      linkedin_url: 'https://linkedin.com/in/ann',
      city: 'Austin',
      state: 'TX',
      country: 'US',
    })
  })
})
