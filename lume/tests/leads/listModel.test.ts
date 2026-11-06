import { describe, expect, it } from 'vitest'
import {
  applyItemEdit,
  dedupeKeys,
  INLINE_MAX_ROWS,
  LIST_COLUMNS,
  listCsvHeader,
  listCsvLine,
  parsePastedRows,
  planAppend,
  type ListItem,
} from '@/lib/leads/lists/model'
import { normaliseLead } from '@/lib/review/model'

const lead = (o: Partial<ListItem>): ListItem => ({ ...normaliseLead({}), ...o })

describe('dedupeKeys', () => {
  it('email lower-cased; LinkedIn reduced to its /in/<slug>; name + company or domain', () => {
    expect(dedupeKeys(lead({ email: ' Jane@Acme.COM ', linkedin_url: 'https://www.linkedin.com/in/Jane-Doe/?trk=x', first_name: 'Jane', last_name: 'Doe', company: 'Acme, Inc.' }))).toEqual({
      email_key: 'jane@acme.com',
      linkedin_key: 'in/jane-doe',
      name_key: 'jane doe|acme',
    })
  })
  it('the domain wins over the company for the name key; nothing to key on → nulls', () => {
    expect(dedupeKeys(lead({ name: 'Jane Doe', domain: 'Acme.com', company: 'Acme LLC' })).name_key).toBe('jane doe|acme.com')
    expect(dedupeKeys(lead({ name: 'Jane Doe' }))).toEqual({ email_key: null, linkedin_key: null, name_key: null })
  })
  it('a bare email without @ is not a key', () => {
    expect(dedupeKeys(lead({ email: 'n/a' })).email_key).toBeNull()
  })
})

describe('planAppend', () => {
  const existing = { emails: new Set(['a@x.com']), linkedins: new Set(['in/bob']), names: new Set(['carol king|king.co']) }
  it('dedupes on email, then LinkedIn, then name + company, against the list and within the batch; rows with nothing to identify are skipped', () => {
    const incoming = [
      lead({ email: 'A@x.com' }), // dup email
      lead({ linkedin_url: 'linkedin.com/in/bob' }), // dup linkedin
      lead({ name: 'Carol King', domain: 'king.co' }), // dup name
      lead({ email: 'new@y.com' }), // add
      lead({ email: 'new@y.com', name: 'Again' }), // dup within batch
      lead({ title: 'CEO' }), // nothing to key on
      lead({ name: 'Dan', company: 'D Co', email: 'b@x.com' }), // add
    ]
    const plan = planAppend(existing, incoming)
    expect(plan.add).toEqual([3, 6])
    expect(plan.duplicates).toBe(4)
    expect(plan.skipped).toBe(1)
  })
  it('stops adding at the room left and counts the rest as over the cap', () => {
    const plan = planAppend({ emails: new Set(), linkedins: new Set(), names: new Set() }, [lead({ email: 'a@a.co' }), lead({ email: 'b@a.co' }), lead({ email: 'c@a.co' })], 2)
    expect(plan.add).toEqual([0, 1])
    expect(plan.over_cap).toBe(1)
  })
})

describe('parsePastedRows', () => {
  it('TSV from a spreadsheet: header detected and mapped like the attachment mapper', () => {
    const text = 'Full Name\tCompany\tWork Email\tLinkedIn\nJane Doe\tAcme\tjane@acme.com\thttps://linkedin.com/in/jane\nBob\tB Co\t\t\n'
    const out = parsePastedRows(text)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.mapping).toMatchObject({ full_name: 'Full Name', company: 'Company', email: 'Work Email', linkedin_url: 'LinkedIn' })
    expect(out.rows).toHaveLength(2)
    expect(out.rows[0].item).toMatchObject({ email: 'jane@acme.com', company: 'Acme', linkedin_url: 'https://linkedin.com/in/jane' })
    expect(out.rows[0].raw).toEqual({ 'Full Name': 'Jane Doe', Company: 'Acme', 'Work Email': 'jane@acme.com', LinkedIn: 'https://linkedin.com/in/jane' })
  })
  it('a one-word full name is still the lead name', () => {
    const out = parsePastedRows('Name\tEmail\nAlpha\ta@a.co\n')
    expect(out.ok && [out.rows[0].item.name, out.rows[0].item.first_name]).toEqual(['Alpha', 'Alpha'])
    const withCo = parsePastedRows('Name\tCompany\nAlpha\tA Co\n')
    expect(withCo.ok && [withCo.rows[0].item.name, withCo.rows[0].item.first_name]).toEqual(['A Co', 'Alpha'])
  })
  it('CSV with quotes; refuses no header / no rows / too many rows', () => {
    const out = parsePastedRows('email,company\n"x@y.com","A, B"\n')
    expect(out.ok && out.rows[0].item.company).toBe('A, B')
    expect(parsePastedRows('').ok).toBe(false)
    expect(parsePastedRows('email\n').ok).toBe(false)
    const big = 'email\n' + Array.from({ length: 5001 }, (_, i) => `a${i}@x.co`).join('\n')
    expect(parsePastedRows(big)).toEqual({ ok: false, error: 'too_many_rows' })
  })
})

describe('applyItemEdit', () => {
  it('edits one mapped field; a blank clears it; name follows company or person', () => {
    const before = lead({ name: 'Acme', company: 'Acme', email: 'a@acme.com', website: 'acme.com', domain: 'acme.com' })
    expect(applyItemEdit(before, { email: ' ' }).email).toBeNull()
    const moved = applyItemEdit(before, { website: 'https://www.newco.io/about' })
    expect([moved.website, moved.domain]).toEqual(['https://www.newco.io/about', 'newco.io'])
    expect(applyItemEdit(before, { company: 'Beta' }).name).toBe('Beta')
  })
})

describe('CSV', () => {
  it('header is the list columns; cells go through the formula-safe writer', () => {
    expect(listCsvHeader()).toBe([...LIST_COLUMNS.map((c) => c.label), 'Source'].join(','))
    const line = listCsvLine(lead({ name: '=HYPERLINK("x")', email: 'a@b.co', phone: '+1 555 123 4567' }), 'manual')
    expect(line.startsWith(`"'=HYPERLINK(""x"")"`)).toBe(true)
    expect(line).toContain('+1 555 123 4567')
    expect(line.endsWith(',manual')).toBe(true)
  })
  it('inline cap is 200', () => expect(INLINE_MAX_ROWS).toBe(200))
})

describe('linkedinKey', () => {
  it('a malformed escape in the slug falls back to the raw slug instead of throwing', async () => {
    const { linkedinKey } = await import('@/lib/leads/lists/model')
    expect(linkedinKey('https://www.linkedin.com/in/jane%E0%A4%A')).toBe('in/jane%e0%a4%a')
  })
})
