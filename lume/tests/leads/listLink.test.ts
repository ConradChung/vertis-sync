import { describe, expect, it } from 'vitest'
import { leadListLink, uniqueLinks } from '@/lib/leads/lists/link'

const ID = '11111111-1111-4111-8111-111111111111'

describe('leadListLink', () => {
  it('a tool result naming a lead list carries an Open in Leads link to it', () => {
    expect(leadListLink({ lead_list: { list_id: ID, name: 'PM' } })).toEqual({ label: 'Open in Leads', href: `/import/leads?list=${ID}` })
  })
  it('anything else carries none (no id, not a uuid, no result)', () => {
    expect(leadListLink({ lead_list: { list_id: 'x' } })).toBeNull()
    expect(leadListLink({ set: { id: ID } })).toBeNull()
    expect(leadListLink(undefined)).toBeNull()
  })
  it('one button per list in a message', () => {
    const a = { label: 'Open in Leads', href: '/import/leads?list=a' }
    expect(uniqueLinks([{ link: a }, {}, { link: a }, { link: { ...a, href: '/import/leads?list=b' } }])).toHaveLength(2)
  })
})
