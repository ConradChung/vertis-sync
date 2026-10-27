import { describe, expect, it } from 'vitest'
import { resolveCampaignQuery } from '@/lib/validate/campaignQuery'

const C = (id: string, name: string, status = 0) => ({ id, name, status })
const list = [C('a', 'Scaleport - R3'), C('b', 'Scaleport - Managers', 1), C('c', 'Kaspen PM'), C('d', 'Old', -1)]

describe('resolveCampaignQuery (telegram-inbox campaign-name reply rules)', () => {
  it('blank → empty', () => expect(resolveCampaignQuery('  ', list)).toEqual({ kind: 'empty' }))
  it('no match → none (deleted campaigns, status < 0, never match)', () => {
    expect(resolveCampaignQuery('zzz', list)).toEqual({ kind: 'none' })
    expect(resolveCampaignQuery('old', list)).toEqual({ kind: 'none' })
  })
  it('one contains-match resolves, case-insensitively', () => {
    expect(resolveCampaignQuery('kaspen', list)).toEqual({ kind: 'resolved', campaign: list[2] })
  })
  it('an exact name wins over prefix siblings', () => {
    expect(resolveCampaignQuery(' scaleport - r3 ', list)).toEqual({ kind: 'resolved', campaign: list[0] })
  })
  it('several → the matches to pick from (max 8)', () => {
    expect(resolveCampaignQuery('scaleport', list)).toEqual({ kind: 'several', matches: [list[0], list[1]] })
    const many = Array.from({ length: 12 }, (_, i) => C(`x${i}`, `Roofers ${i}`))
    const r = resolveCampaignQuery('roofers', many)
    expect(r.kind === 'several' && r.matches.length).toBe(8)
  })
})
