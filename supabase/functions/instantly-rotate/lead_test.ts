// Run: deno test instantly-rotate/
import { assertEquals } from 'jsr:@std/assert@1'
import { rotateLeadBody } from './lead.ts'

const KASPEN = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
const KASPEN_FALLBACK = 'Without a GM, the owner becomes the middle manager.'
const ON_HOOK = 'In Ontario, a standard lease hook.'
const rows = [
  { country: 'CA', region: 'Ontario', city_match: null, jurisdiction: 'Ontario', copy_hook: ON_HOOK, active: true },
  { country: 'US', region: 'Texas', city_match: null, jurisdiction: 'Texas', copy_hook: null, active: true },
]
const q = {
  email: 'a@acme.com', first_name: 'Ann', last_name: 'Lee', company_name: 'Acme', website: 'acme.com',
  personalization: null, location: 'Toronto', operating_cities: 'Toronto; Ottawa',
  country: null, region: null, jurisdiction_line: null,
}

Deno.test('rotateLeadBody: the pre-jurisdiction body is unchanged, plus jurisdiction_line', () => {
  assertEquals(rotateLeadBody(q, KASPEN, rows), {
    campaign: KASPEN, email: 'a@acme.com', first_name: 'Ann', last_name: 'Lee', company_name: 'Acme', website: 'acme.com',
    personalization: null,
    custom_variables: { location: 'Toronto', 'Operating Cities Copied': 'Toronto; Ottawa', jurisdiction_line: KASPEN_FALLBACK },
    skip_if_in_workspace: true,
  })
})

Deno.test('rotateLeadBody: country/region resolve to the active hook at push time', () => {
  const b = rotateLeadBody({ ...q, country: 'CA', region: 'Ontario' }, KASPEN, rows)
  assertEquals(b.custom_variables.jurisdiction_line, ON_HOOK)
})

Deno.test('rotateLeadBody: no hook on the row, inactive row, or uncertain geo -> campaign fallback', () => {
  assertEquals(rotateLeadBody({ ...q, country: 'US', region: 'Texas' }, KASPEN, rows).custom_variables.jurisdiction_line, KASPEN_FALLBACK)
  assertEquals(rotateLeadBody({ ...q, country: 'CA', region: 'Ontario' }, KASPEN, []).custom_variables.jurisdiction_line, KASPEN_FALLBACK)
  assertEquals(rotateLeadBody({ ...q, country: null, region: 'Ontario' }, KASPEN, rows).custom_variables.jurisdiction_line, KASPEN_FALLBACK)
  assertEquals(
    rotateLeadBody(q, 'another-campaign', rows).custom_variables.jurisdiction_line,
    'Most owners end up as the middle manager of their own portfolio.',
  )
})

Deno.test('rotateLeadBody: an explicit lead_bank.jurisdiction_line is sent as is', () => {
  const b = rotateLeadBody({ ...q, country: 'CA', region: 'Ontario', jurisdiction_line: '  Set by hand.  ' }, KASPEN, rows)
  assertEquals(b.custom_variables.jurisdiction_line, 'Set by hand.')
})
