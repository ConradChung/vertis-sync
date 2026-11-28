import { describe, expect, it } from 'vitest'
import type { HiringExtra } from '@/lib/signals/events'
import { BOM, csvField, exportCsv, exportFileName, exportTable, toCsv } from '@/lib/signals/export'
import { applyState, mergeSignals, type SignalEvent, type SignalRow } from '@/lib/signals/merge'
import { inboxRows } from '@/lib/signals/store'

const ev = (o: Partial<SignalEvent> & Pick<SignalEvent, 'source' | 'ref'>): SignalEvent => ({
  company: null, site: null, at: '2026-11-20T00:00:00Z', label: 'x', url: null, phone: null, person: null, person_title: null, linkedin: null, ...o,
})
const rowsOf = (events: SignalEvent[], states: Parameters<typeof applyState>[1] = []): SignalRow[] => applyState(mergeSignals(events), states)

describe('csvField', () => {
  it('RFC 4180: quotes cells with a comma, quote or line break and doubles quotes', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('two\nlines')).toBe('"two\nlines"')
    expect(csvField('cr\rhere')).toBe('"cr\rhere"')
  })
  it('empty for unknown values, never a placeholder', () => {
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
    expect(csvField('')).toBe('')
    expect(csvField(Number.NaN)).toBe('')
    expect(csvField(1200)).toBe('1200')
  })
  it('a cell starting with = + - @ tab or CR gets a leading apostrophe', () => {
    expect(csvField('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"')
    expect(csvField('+1 514-503-7171')).toBe("'+1 514-503-7171")
    expect(csvField('-2+3')).toBe("'-2+3")
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvField('\tcmd')).toBe("'\tcmd")
    expect(csvField('\rcmd')).toBe('"\'\rcmd"')
    expect(csvField('ok = fine')).toBe('ok = fine')
  })
})

describe('toCsv / exportFileName', () => {
  it('starts with a UTF-8 BOM, uses CRLF, and keeps non-ASCII text', () => {
    const out = toCsv(['A', 'B'], [['é,ü', 1]])
    expect(out.startsWith(BOM)).toBe(true)
    expect(out).toBe(`${BOM}A,B\r\n"é,ü",1\r\n`)
  })
  it('names the file signals-<tab>[-500plus]-YYYY-MM-DD.csv', () => {
    const now = new Date('2026-11-27T20:00:00Z')
    expect(exportFileName('hiring', true, now)).toBe('signals-hiring-500plus-2026-11-27.csv')
    expect(exportFileName('all', false, now)).toBe('signals-all-2026-11-27.csv')
    expect(exportFileName('comments', false, now)).toBe('signals-comments-2026-11-27.csv')
  })
})

describe('column order per tab', () => {
  const hiringRow: HiringExtra = {
    id: 9, role_title: 'Regional Manager', role_tier: 'leadership', location: 'Austin, TX', country: 'US', posted_at: '2026-11-18T18:00:00Z', source_url: 'https://jobs.example/9',
    company_linkedin: 'https://linkedin.com/company/acme', company_phone: '(512) 555-0100', contact_name: 'Ada Lovelace', contact_title: 'COO', contact_linkedin: 'https://linkedin.com/in/ada',
    contact_email: 'ada@acme.com', person_name: null, person_title: null, person_linkedin: null, pm_fit: 'fit', created_at: '2026-11-19T18:00:00Z',
  }
  const rows = rowsOf(
    [ev({ source: 'hiring', ref: 'hiring:9', company: 'Acme PM', site: 'acme.com', label: 'Hiring: Regional Manager', detail: { source: 'hiring', signal: 'Hiring', role: 'Regional Manager' }, doors: { count: 1200, source: 'apollo', confidence: 'high' } })],
    [{ account_key: 'd:acme.com', status: 'working', email_touched_at: '2026-11-21T20:00:00Z', linkedin_touched_at: null, call_touched_at: null, deal_id: null }]
  )
  it('hiring: the owner\'s order, one line per account, unknowns empty', () => {
    const t = exportTable('hiring', rows, new Map([['hiring:9', hiringRow]]))
    expect(t.header).toEqual([
      'Company', 'Website / domain', 'Doors', 'Doors source', 'Doors confidence', 'Role title', 'Role tier', 'Location', 'Country', 'Posted date', 'Job post URL',
      'Contact name', 'Contact title', 'Contact LinkedIn', 'Contact email', 'Company phone', 'Company LinkedIn', 'Fit verdict', 'Status', 'Email touched', 'LinkedIn touched', 'Call touched', 'Added date',
    ])
    expect(t.records).toEqual([[
      'Acme PM', 'acme.com', 1200, 'apollo', 'high', 'Regional Manager', 'leadership', 'Austin, TX', 'US', '2026-11-18', 'https://jobs.example/9',
      'Ada Lovelace', 'COO', 'https://linkedin.com/in/ada', 'ada@acme.com', '(512) 555-0100', 'https://linkedin.com/company/acme', 'fit', 'working', '2026-11-21', '', '', '2026-11-19',
    ]])
  })
  it('an account with no count has empty door cells; the file never contains the word Unknown', () => {
    const none = rowsOf([ev({ source: 'hiring', ref: 'hiring:1', company: 'No Count Co', site: 'nocount.com' })])
    const t = exportTable('hiring', none, new Map())
    expect(t.records[0].slice(2, 5)).toEqual(['', '', ''])
    expect(exportCsv('hiring', none, new Map())).not.toMatch(/unknown/i)
  })
  it('comments: person first, then company, doors and the comment', () => {
    const c = rowsOf([
      ev({
        source: 'comment', ref: 'comment:1', company: 'Acme PM', site: 'acme.com', person: 'Sergii S', person_title: 'CEO', linkedin: 'https://linkedin.com/in/s', url: 'https://linkedin.com/c/1',
        detail: { source: 'comment', reaction: false, comment: 'Great, point', post_url: 'https://linkedin.com/posts/1', post_excerpt: null }, doors: { count: 4000, source: 'owner', confidence: 'high' },
      }),
    ])
    const t = exportTable('comments', c, new Map())
    expect(t.header.slice(0, 8)).toEqual(['Person', 'Title', 'LinkedIn', 'Company', 'Website / domain', 'Doors', 'Doors source', 'Doors confidence'])
    expect(t.records[0].slice(0, 12)).toEqual(['Sergii S', 'CEO', 'https://linkedin.com/in/s', 'Acme PM', 'acme.com', 4000, 'owner', 'high', 'Comment', 'Great, point', 'https://linkedin.com/c/1', 'https://linkedin.com/posts/1'])
  })
  it('all: company first, sources joined, hiring contact email where found', () => {
    const t = exportTable('all', rows, new Map([['hiring:9', hiringRow]]))
    expect(t.header.slice(0, 5)).toEqual(['Company', 'Website / domain', 'Doors', 'Doors source', 'Doors confidence'])
    expect(t.records[0].slice(0, 9)).toEqual(['Acme PM', 'acme.com', 1200, 'apollo', 'high', '', '', '', 'ada@acme.com'])
  })
  it('scraped text that looks like a formula is neutralised in the file', () => {
    const evil = rowsOf([ev({ source: 'hiring', ref: 'hiring:2', company: '=cmd|\' /C calc\'!A0', site: 'evil.com' })])
    const csv = exportCsv('hiring', evil, new Map())
    expect(csv.split('\r\n')[1].startsWith("'=cmd")).toBe(true)
  })
})

describe('the export is the rows on screen: filter to rows', () => {
  const events = [
    ev({ source: 'hiring', ref: 'hiring:1', company: 'Big PM', site: 'big.com', doors: { count: 800, source: null, confidence: null }, at: '2026-11-25T00:00:00Z' }),
    ev({ source: 'hiring', ref: 'hiring:2', company: 'Edge PM', site: 'edge.com', doors: { count: 500, source: null, confidence: null }, at: '2026-11-24T00:00:00Z' }),
    ev({ source: 'hiring', ref: 'hiring:3', company: 'Small PM', site: 'small.com', doors: { count: 499, source: null, confidence: null }, at: '2026-11-23T00:00:00Z' }),
    ev({ source: 'hiring', ref: 'hiring:4', company: 'Mystery PM', site: 'mystery.com', at: '2026-11-22T00:00:00Z' }),
    ev({ source: 'comment', ref: 'comment:1', company: 'Chatty PM', site: 'chatty.com', doors: { count: 2000, source: null, confidence: null }, at: '2026-11-21T00:00:00Z' }),
  ]
  const states = [{ account_key: 'd:big.com', status: 'working' as const, email_touched_at: null, linkedin_touched_at: null, call_touched_at: null, deal_id: null }]
  const rows = rowsOf(events, states)
  const names = (r: SignalRow[]) => r.map((x) => x.name)

  it('hiring tab with 500+ keeps 500 and up, drops under 500 and unknowns', () => {
    expect(names(inboxRows(rows, { source: 'hiring', minDoors: 500 }).shown)).toEqual(['Big PM', 'Edge PM'])
  })
  it('status, search and sort narrow it the same way the table does', () => {
    expect(names(inboxRows(rows, { source: 'hiring', status: 'working' }).shown)).toEqual(['Big PM'])
    expect(names(inboxRows(rows, { source: 'all', q: 'chat' }).shown)).toEqual(['Chatty PM'])
    expect(names(inboxRows(rows, { source: 'all', minDoors: 500 }, 'desc').shown)).toEqual(['Chatty PM', 'Big PM', 'Edge PM'])
    expect(names(inboxRows(rows, { source: 'all' }, 'asc').shown)).toEqual(['Small PM', 'Edge PM', 'Big PM', 'Chatty PM', 'Mystery PM'])
  })
  it('is not capped at a page: every matching account is returned', () => {
    const many = rowsOf(Array.from({ length: 250 }, (_, i) => ev({ source: 'hiring', ref: `hiring:${i}`, company: `Co ${i}`, site: `co${i}.com`, doors: { count: 600, source: null, confidence: null } })))
    expect(inboxRows(many, { source: 'hiring', minDoors: 500 }).shown).toHaveLength(250)
  })
})
