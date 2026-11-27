import { describe, expect, it } from 'vitest'
import { applyState, doorCount, filterRows, formatDoors, mergeSignals, sortByDoors, type SignalEvent } from '@/lib/signals/merge'
import { personEvent, reactorEvent, type PersonSource, type ReactorSource } from '@/lib/signals/events'

const ev = (o: Partial<SignalEvent> & Pick<SignalEvent, 'source' | 'ref'>): SignalEvent => ({
  company: 'Acme PM',
  site: 'acme.com',
  at: '2026-11-01T00:00:00Z',
  label: 'x',
  url: null,
  phone: null,
  person: null,
  person_title: null,
  linkedin: null,
  ...o,
})
const doors = (count: number, source: string | null = null, confidence: string | null = null) => ({ count, source, confidence })

describe('doorCount / formatDoors', () => {
  it('keeps only positive whole counts; zero and junk are unknown', () => {
    expect(doorCount(1200, 'apollo', 'high')).toEqual({ count: 1200, source: 'apollo', confidence: 'high' })
    expect(doorCount(0)).toBeNull()
    expect(doorCount(null)).toBeNull()
    expect(doorCount('800')).toBeNull()
    expect(doorCount(-5)).toBeNull()
  })
  it('uses thousands separators', () => {
    expect(formatDoors(1200)).toBe('1,200')
    expect(formatDoors(950)).toBe('950')
  })
})

describe('merging door counts', () => {
  it('an account takes the count from its most recent signal that has one', () => {
    const [a] = mergeSignals([
      ev({ source: 'comment', ref: 'comment:1', at: '2026-11-01T00:00:00Z', doors: doors(300, 'site') }),
      ev({ source: 'influencer', ref: 'influencer:1', at: '2026-11-10T00:00:00Z', doors: doors(1200) }),
      ev({ source: 'comment', ref: 'comment:2', at: '2026-11-20T00:00:00Z', doors: null }),
      ev({ source: 'hiring', ref: 'hiring:1', at: '2026-11-25T00:00:00Z' }),
    ])
    expect(a.count).toBe(4)
    expect(a.doors).toEqual({ count: 1200, source: null, confidence: null })
  })
  it('is unknown when no signal has one', () => {
    const [a] = mergeSignals([ev({ source: 'hiring', ref: 'hiring:1' })])
    expect(a.doors).toBeNull()
  })
})

describe('sortByDoors', () => {
  const rows = [{ k: 'u1', doors: null }, { k: 'a', doors: doors(500) }, { k: 'b', doors: doors(2000) }, { k: 'u2' }, { k: 'c', doors: doors(50) }]
  it('highest first with unknowns last', () => {
    expect(sortByDoors(rows, 'desc').map((r) => r.k)).toEqual(['b', 'a', 'c', 'u1', 'u2'])
  })
  it('lowest first still puts unknowns last', () => {
    expect(sortByDoors(rows, 'asc').map((r) => r.k)).toEqual(['c', 'a', 'b', 'u1', 'u2'])
  })
  it('does not mutate its input', () => {
    const before = rows.map((r) => r.k)
    sortByDoors(rows, 'desc')
    expect(rows.map((r) => r.k)).toEqual(before)
  })
})

describe('the 500+ filter', () => {
  const accounts = applyState(
    mergeSignals([
      ev({ source: 'comment', ref: 'c:1', company: 'Big', site: 'big.com', doors: doors(500) }),
      ev({ source: 'comment', ref: 'c:2', company: 'Small', site: 'small.com', doors: doors(499) }),
      ev({ source: 'comment', ref: 'c:3', company: 'Unknown', site: 'unknown.com' }),
    ]),
    []
  )
  it('hides rows under 500 and unknowns, keeps exactly 500', () => {
    expect(filterRows(accounts, { minDoors: 500 }).map((r) => r.name)).toEqual(['Big'])
  })
  it('is off by default', () => {
    expect(filterRows(accounts, {})).toHaveLength(3)
  })
})

describe('source rows carry their counts', () => {
  const person = (o: Partial<PersonSource> = {}): PersonSource => ({
    id: 1, kind: 'commenter', stage: 'ready', skip_reason: null, name: 'Ada', title: null, linkedin_url: null, company_name: 'Acme PM', company_website: 'acme.com',
    post_id: null, comment_text: 'hi', comment_url: null, commented_at: '2026-11-01T00:00:00Z', created_at: '2026-11-01T00:00:00Z', ...o,
  })
  it('signal_people brings count, source and confidence; influencer_reactors the count', () => {
    expect(personEvent(person({ door_count: 1200, door_count_source: 'owner', door_count_confidence: 'high' }), new Map())?.doors).toEqual({ count: 1200, source: 'owner', confidence: 'high' })
    expect(personEvent(person({ door_count: null }), new Map())?.doors).toBeNull()
    const r: ReactorSource = { id: 2, name: 'B', title: null, linkedin_url: null, company_name: 'X', company_website: 'x.com', reacted_to: [], door_count: 900, verdict: 'verified', verified_at: null, updated_at: null }
    expect(reactorEvent(r)?.doors?.count).toBe(900)
  })
})
