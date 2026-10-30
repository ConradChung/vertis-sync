import { describe, expect, it } from 'vitest'
import { csvCell } from '@/lib/csv/cell'
import { csvCell as influencerCsvCell } from '@/lib/influencers/model'
import { toApolloCsv } from '@/lib/apollo/records'
import { sheetToIngestCsv } from '@/lib/sheets/model'

/** Formula injection in exported CSVs (review item 4): one shared cell writer. */

const EVIL = ['=HYPERLINK("http://x","click")', '+cmd|calc', '-2+3', '@SUM(A1)', '\t=1', '\r=1']

describe('csvCell', () => {
  it('prefixes a leading = + - @ (and a tab / CR) with a quote', () => {
    expect(EVIL.map(csvCell)).toEqual(['"\'=HYPERLINK(""http://x"",""click"")"', "'+cmd|calc", "'-2+3", "'@SUM(A1)", "'=1", "'=1"])
    expect(csvCell('Acme, Inc')).toBe('"Acme, Inc"')
    expect(csvCell(12)).toBe('12')
    expect(csvCell(null)).toBe('')
  })
  it('leaves phone numbers and plain numbers unchanged (no letters, no | or !)', () => {
    for (const v of ['+1 555 123 4567', '-5', '(555) 123-4567', '+44 (0)20 7946 0958', '555.123.4567', '-3.5', '+1/555/0100']) expect(csvCell(v), v).toBe(v)
  })
  it('still neutralises formulas that start like numbers', () => {
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)")
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell("-1+cmd|' /C calc'!A0")).toBe("'-1+cmd|' /C calc'!A0")
    expect(csvCell('@x')).toBe("'@x")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell('+1 555|calc')).toBe("'+1 555|calc")
  })
  it('is the same helper the influencer export uses', () => {
    expect(influencerCsvCell).toBe(csvCell)
  })
})

describe('exports neutralise formulas', () => {
  it('the Apollo CSV (review sets → export_for_apollo)', () => {
    const csv = toApolloCsv([{ first_name: '=1+1', last_name: '@x', email: null, title: '+t', company: '-c', website: null, domain: null, linkedin_url: null, city: null, state: null, country: null }])
    expect(csv.split('\n')[1]).toBe("'=1+1,'@x,,'+t,'-c,,,,,,")
  })
  it('the ingest CSV from an attached sheet', () => {
    // Phone numbers go to validation as written.
    expect(sheetToIngestCsv({ header: ['Name', '=evil'], rows: [['@a', '+1 555 0100'], ['Ann, A', 'two\nlines']] })).toBe("Name,'=evil\n'@a,+1 555 0100\n\"Ann, A\",two lines\n")
  })
})
