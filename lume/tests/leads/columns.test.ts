import { describe, expect, it } from 'vitest'
import { editCell, flattenRecord, labelCells, mergeColumns, MAX_COLUMNS, sendHeader, cellsCsvLine } from '@/lib/leads/columns'
import { normaliseLead } from '@/lib/review/model'

describe('flattenRecord', () => {
  it('keeps the actor key order; nested objects as a.b; arrays of values joined; arrays of objects as JSON; nulls blank', () => {
    const out = flattenRecord({ title: 'Roof Co', author: { name: 'Jane', meta: { id: 7 } }, tags: ['a', 'b'], reviews: [{ s: 5 }], phone: null, score: 4.5, open: true })
    expect(Object.keys(out)).toEqual(['title', 'author.name', 'author.meta.id', 'tags', 'reviews', 'phone', 'score', 'open'])
    expect(out).toMatchObject({ 'author.name': 'Jane', 'author.meta.id': '7', tags: 'a; b', reviews: '[{"s":5}]', phone: '', score: '4.5', open: 'true' })
  })
  it('stops descending after 3 levels (JSON beyond) and caps a cell at 5000 characters', () => {
    const out = flattenRecord({ a: { b: { c: { d: { e: 1 } } } }, long: 'x'.repeat(6000) })
    expect(out['a.b.c']).toBe('{"d":{"e":1}}')
    expect(out.long).toHaveLength(5000)
  })
})

describe('mergeColumns', () => {
  it('union in first-seen order: the first item’s keys, then later keys appended; capped', () => {
    expect(mergeColumns(['a'], [{ a: '1', b: '2' }, { c: '3', b: '' }])).toEqual(['a', 'b', 'c'])
    const wide = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, 'v']))
    expect(mergeColumns([], [wide])).toHaveLength(MAX_COLUMNS)
  })
})

describe('labelCells', () => {
  it('a lead written by the agent or the owner shows under readable labels', () => {
    expect(labelCells({ ...normaliseLead({}), first_name: 'Jane', email: 'j@a.co' })).toEqual({ 'First Name': 'Jane', Email: 'j@a.co' })
  })
})

describe('editCell', () => {
  it('edits the cell; a helper field that showed the old value follows it (so dedupe and the email column stay right)', () => {
    const item = { ...normaliseLead({}), email: 'old@a.co', company: 'Acme', name: 'Acme' }
    const r = editCell({ contactEmail: 'old@a.co', company_name: 'Acme' }, item, 'contactEmail', 'new@a.co')
    expect(r.cells.contactEmail).toBe('new@a.co')
    expect(r.item.email).toBe('new@a.co')
    // An empty cell whose header names a field (email, LinkedIn, …) fills that field.
    expect(editCell({}, { ...item, email: null }, 'Work Email', 'w@a.co').item.email).toBe('w@a.co')
    const other = editCell({ notes: 'x' }, item, 'notes', 'y')
    expect(other.item).toEqual(item)
  })
})

describe('sendHeader', () => {
  it('uses the source columns when one email column is detected', () => {
    expect(sendHeader(['name', 'email', 'phone'])).toEqual({ header: ['name', 'email', 'phone'], emailColumn: 'email', added: false })
  })
  it('none or several: adds Email (from the helper) and renames the clashing columns so detection finds exactly one', () => {
    expect(sendHeader(['name', 'phone'])).toEqual({ header: ['name', 'phone', 'Email'], emailColumn: 'Email', added: true })
    const two = sendHeader(['email', 'Work Email', 'x'])
    expect(two.emailColumn).toBe('Email')
    expect(two.header).toEqual(['email (source)', 'Work Email (source)', 'x', 'Email'])
  })
  it('CSV line: cells in column order, blanks for missing, through the formula-safe writer', () => {
    expect(cellsCsvLine({ a: '=1+1', c: 'x,y' }, ['a', 'b', 'c'])).toBe(`'=1+1,,"x,y"`)
  })
})
