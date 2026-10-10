import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  classifyPool,
  companiesNeeded,
  companiesToTake,
  contactCountFor,
  parseSheetDate,
  titleTier,
  withinLookback,
} from './pool.ts'

Deno.test('titleTier: strict GTM is 1, adjacent is 2, everything else is 3', () => {
  assertEquals(titleTier('Founding GTM Engineer'), 1)
  assertEquals(titleTier('Growth Engineer'), 1)
  assertEquals(titleTier('Founding Account Executive'), 2)
  assertEquals(titleTier('Revenue Operations Manager'), 2)
  assertEquals(titleTier('GTM Strategy & Operations Analyst'), 2)
  assertEquals(titleTier('Founding Sales Engineer'), 2)
  assertEquals(titleTier('Software Engineer, Growth'), 2)
  assertEquals(titleTier('Sales Development Representative'), 2)
  assertEquals(titleTier('Account Executive'), 3)
  assertEquals(titleTier('Mid-Market Account Executive (NYC)'), 3)
  assertEquals(titleTier(''), 3)
})

Deno.test('parseSheetDate: ISO, serial, relative (incl. truncated), garbage', () => {
  const today = '2026-10-09'
  assertEquals(parseSheetDate('2026-09-17', today), '2026-09-17')
  assertEquals(parseSheetDate('2026-9-7', today), '2026-09-07')
  assertEquals(parseSheetDate(46307, today), '2026-10-12')
  assertEquals(parseSheetDate('21 days ag', today), '2026-09-18')
  assertEquals(parseSheetDate('about 2 months ago', today), '2026-08-10')
  assertEquals(parseSheetDate('about 1 ye', today), '2025-10-09')
  assertEquals(parseSheetDate('a month ago', today), '2026-09-09')
  assertEquals(parseSheetDate('', today), null)
  assertEquals(parseSheetDate('TBD', today), null)
})

Deno.test('withinLookback: either date inside the window passes; no dates passes', () => {
  assert(withinLookback('2026-09-17', '', '2026-10-09', 365))
  assert(withinLookback('2023-06-30', '2026-10-09', '2026-10-09', 365)) // old posting, added today
  assert(!withinLookback('2023-06-30', '', '2026-10-09', 365))
  assert(withinLookback('', '', '2026-10-09', 365))
  assert(withinLookback('2026-10-11', '', '2026-10-09', 365)) // slight future = timezone
})

Deno.test('classifyPool: excludes, dedupes, tiers and sorts', () => {
  const headers = ['companyName', 'title', 'status', 'companyWebsite', 'postedAt', 'added_on']
  const rows = [
    ['Acme', 'GTM Engineer', '', 'https://acme.com', '2026-09-01', ''],
    ['Acme Inc', 'Account Executive', '', 'acme.com', '2026-09-20', ''],            // same company, worse tier
    ['Beta', 'Founding Account Executive', '', 'beta.io', '2026-09-10', ''],
    ['Gamma', 'Account Executive', '', 'gamma.co', '2026-09-30', ''],
    ['Old', 'GTM Engineer', '', 'old.com', '2023-01-01', ''],                      // outside window
    ['Nope', 'GTM Engineer', 'Not a Right Fit', 'nope.com', '2026-09-01', ''],
    ['InGtm', 'GTM Engineer', '', 'ingtm.com', '2026-09-01', ''],
    ['Taken', 'GTM Engineer', '', 'taken.com', '2026-09-01', ''],
    ['Newest', 'Growth Engineer', '', 'newest.ai', '2026-10-09', '2026-10-09'],
    ['', 'GTM Engineer', '', 'blank.com', '2026-09-01', ''],                       // no name -> dropped
  ]
  const pool = classifyPool(headers, rows, {
    batchDate: '2026-10-09',
    lookbackDays: 365,
    gtmNames: new Set(['ingtm']),
    gtmDomains: new Set(),
    takenDomains: new Set(['taken.com']),
    takenNames: new Set(),
  })
  assertEquals(pool.eligible.map(r => r.company_name), ['Newest', 'Acme', 'Beta', 'Gamma'])
  assertEquals(pool.eligible.map(r => r.tier), [1, 1, 2, 3])
  assertEquals(pool.byTier, { 1: 2, 2: 1, 3: 1 })
  assertEquals(pool.newRows, 1)
  assertEquals(pool.excluded.map(r => `${r.company_name}:${r.exclude}`).sort(),
    ['InGtm:already_in_gtm', 'Nope:not_a_right_fit', 'Old:outside_lookback', 'Taken:already_taken'])
  assertEquals(pool.eligible[1].domain, 'acme.com')
  assertEquals(pool.eligible[1].title, 'GTM Engineer')
})

Deno.test('order sizing: 34 companies for 500 at 15 each, cushioned takes, capped at 60', () => {
  assertEquals(companiesNeeded(), 34)
  assertEquals(companiesToTake(0, 0), 43)
  assertEquals(companiesToTake(30, 0), 5)
  assertEquals(companiesToTake(34, 0), 0)
  assertEquals(companiesToTake(20, 10), 5)
  assertEquals(companiesToTake(10, 0), 30)
  assertEquals(companiesToTake(55, 4), 0)    // already past the need
  assertEquals(contactCountFor(3), 500)
  assertEquals(contactCountFor(40), 600)
})
