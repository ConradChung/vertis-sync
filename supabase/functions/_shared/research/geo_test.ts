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
  assertEquals(countryInText('Canada', 'Serving Canada'), true)
})

// --- round-2 review I1 ------------------------------------------------------------
import { placeInText, regionInText } from './geo.ts'

Deno.test('countryInText: all-caps navigation text is not a country ("ABOUT US | CONTACT US")', () => {
  assertEquals(countryInText('United States', 'ABOUT US | CONTACT US'), false)
  assertEquals(countryInText('United States', 'MADE IN USA'), false)
  assertEquals(countryInText('United States', 'Austin, TX, US'), true)
  assertEquals(countryInText('United States', 'Austin, Texas, USA'), true)
  assertEquals(countryInText('United States', 'offices across the U.S. and Canada'), true)
})

Deno.test('countryInText: adjectives and sub-regions are not countries', () => {
  assertEquals(countryInText('United Kingdom', 'Vancouver, British Columbia'), false)
  assertEquals(countryInText('United Kingdom', 'Serving New England since 1990'), false)
  assertEquals(countryInText('United States', 'Serving clients across North America'), false)
  assertEquals(countryInText('United Kingdom', 'Sydney, New South Wales'), false)
  assertEquals(countryInText('Canada', 'Proudly Canadian'), false)
  assertEquals(countryInText('United Kingdom', 'London, United Kingdom'), true)
})

Deno.test('regionInText: 2-letter codes only as case-sensitive standalone upper-case tokens', () => {
  assertEquals(regionInText('ON', 'Contact our team today'), false)
  assertEquals(regionInText('ON', 'ON SALE NOW'), false)
  assertEquals(regionInText('IN', 'Homes in Toronto'), false)
  assertEquals(regionInText('ON', 'Toronto, ON M5V 2T6'), true)
  assertEquals(regionInText('BC', 'Vancouver, BC'), true)
  assertEquals(regionInText('bc', 'Vancouver, BC'), true)
})

Deno.test('regionInText: full names whole-word, case-insensitive, not inside a longer place name', () => {
  assertEquals(regionInText('British Columbia', 'Vancouver, british columbia'), true)
  assertEquals(regionInText('Texas', 'Austin, Texas, USA'), true)
  assertEquals(regionInText('England', 'Serving New England since 1990'), false)
  assertEquals(regionInText('Wales', 'Sydney, New South Wales'), false)
  assertEquals(regionInText('Virginia', 'Charleston, West Virginia'), false)
  assertEquals(regionInText('Ontario', 'Ontarion Holdings'), false)
})

Deno.test('placeInText: whole words, case-insensitive', () => {
  assertEquals(placeInText('Toronto', 'Homes in Toronto'), true)
  assertEquals(placeInText('York', 'New Yorker magazine'), false)
})
