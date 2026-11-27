import { describe, expect, it } from 'vitest'
import { personEvent, type PersonSource } from '@/lib/signals/events'
import { DEFAULT_ICP, readIcp, releaseOf } from '@/lib/signals/icp'
import { mergeSignals } from '@/lib/signals/merge'

const person = (o: Partial<PersonSource>): PersonSource => ({
  id: 1, kind: 'commenter', stage: 'ready', skip_reason: null, name: 'Dana Whitfield', title: 'Owner', linkedin_url: 'https://www.linkedin.com/in/dana',
  company_name: 'Whitfield Holdings', company_website: 'https://whitfield.com', post_id: null, comment_text: 'Great post', comment_url: null,
  commented_at: '2026-11-25T18:00:00Z', created_at: '2026-11-25T18:00:00Z', ...o,
})
const none = new Map()

describe('ICP gate in Lume', () => {
  it('a held person shows in Signals with "Units unknown" (held list) and stays out of Today', () => {
    const [acct] = mergeSignals([personEvent(person({ id: 7, stage: 'held' }), none)!])
    expect(acct.held).toEqual([{ id: 7, name: 'Dana Whitfield' }])
    expect(acct.queue_ready).toBe(false)
  })
  it('only people who passed the gate (ready / alerted) make the account Today-ready', () => {
    for (const stage of ['ready', 'alerted']) expect(mergeSignals([personEvent(person({ stage }), none)!])[0].queue_ready).toBe(true)
    for (const stage of ['triage', 'verify', 'crawl', 'doors', 'contacts', 'draft']) expect(mergeSignals([personEvent(person({ stage }), none)!])[0].queue_ready).toBe(false)
    expect(personEvent(person({ stage: 'skipped', skip_reason: 'pm_company' }), none)).toBeNull()
  })
  it('an account with another lead source (hiring) still reaches Today even if its LinkedIn person is held', () => {
    const held = personEvent(person({ stage: 'held' }), none)!
    const hiring = { source: 'hiring' as const, ref: 'hiring:1', company: 'Whitfield Holdings', site: 'whitfield.com', at: null, label: 'Hiring', url: null, phone: null, person: null, person_title: null, linkedin: null }
    expect(mergeSignals([held, hiring])[0].queue_ready).toBe(true)
  })
  it('the typed count releases at or above the minimum (from signal_config.icp) and skips below it', () => {
    expect(readIcp(undefined)).toEqual(DEFAULT_ICP)
    expect([releaseOf(500, DEFAULT_ICP), releaseOf(499, DEFAULT_ICP)]).toEqual(['continue', 'skip'])
    expect(releaseOf(300, readIcp({ min_units: 250 }))).toBe('continue')
  })
})
