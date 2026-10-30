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
    expect(sheetToIngestCsv({ header: ['Name', '=evil'], rows: [['@a', '+1 555 0100'], ['Ann, A', 'two\nlines']] })).toBe("Name,'=evil\n'@a,'+1 555 0100\n\"Ann, A\",two lines\n")
  })
})
