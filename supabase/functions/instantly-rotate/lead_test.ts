// Run: deno test instantly-rotate/
import { assertEquals } from 'jsr:@std/assert@1'
import { rotateLeadBody } from './lead.ts'

const KASPEN = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
const FALLBACK = 'local landlord-tenant law'
const ON_LAW = 'Residential Tenancies Act, 2006'
const rows = [
  { country: 'CA', region: 'Ontario', city_match: null, jurisdiction: 'Ontario', compliance_name: ON_LAW, active: true },
  { country: 'US', region: 'Texas', city_match: null, jurisdiction: 'Texas', compliance_name: null, active: true },
]
const q = {
  email: 'a@acme.com', first_name: 'Ann', last_name: 'Lee', company_name: 'Acme', website: 'acme.com',
  personalization: null, location: 'Toronto', operating_cities: 'Toronto; Ottawa',
  country: null, region: null, compliance_law: null,
}

Deno.test('rotateLeadBody: the pre-jurisdiction body is unchanged, plus compliance_law', () => {
  assertEquals(rotateLeadBody(q, KASPEN, rows), {
    campaign: KASPEN, email: 'a@acme.com', first_name: 'Ann', last_name: 'Lee', company_name: 'Acme', website: 'acme.com',
    personalization: null,
    custom_variables: { location: 'Toronto', 'Operating Cities Copied': 'Toronto; Ottawa', compliance_law: FALLBACK },
    skip_if_in_workspace: true,
  })
})

Deno.test('rotateLeadBody: country/region resolve to the active compliance_name at push time', () => {
  assertEquals(rotateLeadBody({ ...q, country: 'CA', region: 'Ontario' }, KASPEN, rows).custom_variables.compliance_law, ON_LAW)
})

Deno.test('rotateLeadBody: no name on the row, no rows, or uncertain geo -> the same generic fallback for every campaign', () => {
  assertEquals(rotateLeadBody({ ...q, country: 'US', region: 'Texas' }, KASPEN, rows).custom_variables.compliance_law, FALLBACK)
  assertEquals(rotateLeadBody({ ...q, country: 'CA', region: 'Ontario' }, KASPEN, []).custom_variables.compliance_law, FALLBACK)
  assertEquals(rotateLeadBody({ ...q, country: null, region: 'Ontario' }, KASPEN, rows).custom_variables.compliance_law, FALLBACK)
  assertEquals(rotateLeadBody(q, 'another-campaign', rows).custom_variables.compliance_law, FALLBACK)
})

Deno.test('rotateLeadBody: an explicit lead_bank.compliance_law is sent as is; the old jurisdiction_line key is gone', () => {
  const b = rotateLeadBody({ ...q, country: 'CA', region: 'Ontario', compliance_law: '  Set by hand  ' }, KASPEN, rows)
  assertEquals(b.custom_variables.compliance_law, 'Set by hand')
  assertEquals('jurisdiction_line' in b.custom_variables, false)
})
