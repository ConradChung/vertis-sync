import { describe, expect, it } from 'vitest'
import { gateKey, parseGateParam } from '@/lib/validate/deepLink'

const ID = '7db3d841-252c-4572-95ec-bc110727df8d'

describe('parseGateParam', () => {
  it('parses kind:id', () => {
    expect(parseGateParam(`campaign_choice:${ID}`)).toEqual({ kind: 'campaign_choice', targetId: ID, key: `campaign_choice:${ID}` })
  })
  it('lowercases the uuid (DB form)', () => {
    expect(parseGateParam(`stall:${ID.toUpperCase()}`)?.targetId).toBe(ID)
  })
  it.each([
    [null],
    [''],
    ['campaign_choice'],
    [`nope:${ID}`],
    ['stall:not-a-uuid'],
    [`stall:${ID}:extra`],
    [`:${ID}`],
    [' stall:x '],
  ])('rejects %j', (v) => {
    expect(parseGateParam(v)).toBeNull()
  })
  it('trims whitespace', () => {
    expect(parseGateParam(` stall:${ID} `)?.kind).toBe('stall')
  })
})

describe('gateKey', () => {
  it('joins kind and id', () => expect(gateKey({ kind: 'stall', target_id: ID })).toBe(`stall:${ID}`))
})
