import { assertEquals } from 'jsr:@std/assert@1'
import { canonicalCountry, countryInText, regionCountry } from './geo.ts'

Deno.test('canonicalCountry: names and aliases -> one name', () => {
  assertEquals(canonicalCountry('usa'), 'United States')
  assertEquals(canonicalCountry('U.S.'), 'United States')
  assertEquals(canonicalCountry('United Kingdom'), 'United Kingdom')
  assertEquals(canonicalCountry('UK'), 'United Kingdom')
  assertEquals(canonicalCountry('UAE'), 'United Arab Emirates')
  assertEquals(canonicalCountry('Narnia'), null)
})

Deno.test('regionCountry: provinces, states, emirates, UK nations (names and abbreviations)', () => {
  assertEquals(regionCountry('BC'), 'Canada')
  assertEquals(regionCountry('British Columbia'), 'Canada')
  assertEquals(regionCountry('Ontario'), 'Canada')
  assertEquals(regionCountry('CA'), 'United States')
  assertEquals(regionCountry('Texas'), 'United States')
  assertEquals(regionCountry('D.C.'), 'United States')
  assertEquals(regionCountry('Dubai'), 'United Arab Emirates')
  assertEquals(regionCountry('Scotland'), 'United Kingdom')
  assertEquals(regionCountry('Atlantis'), null)
})

Deno.test('countryInText: full names case-insensitive, short aliases only as upper-case words', () => {
  assertEquals(countryInText('United States', 'serving the united states'), true)
  assertEquals(countryInText('United States', 'Contact us today'), false)
  assertEquals(countryInText('United States', 'Based in the US.'), true)
  assertEquals(countryInText('United Kingdom', 'Offices across the UK'), true)
  assertEquals(countryInText('United Kingdom', 'a bulk order'), false)
  assertEquals(countryInText('Canada', 'Proudly Canadian'), true)
})
