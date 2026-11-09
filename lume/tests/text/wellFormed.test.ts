import { describe, expect, it } from 'vitest'
import { clip, deepWellFormed, wellFormed } from '@/lib/text/wellFormed'

const HALF_HIGH = '\uD83D' // first half of 😀
const HALF_LOW = '\uDE00'

describe('wellFormed', () => {
  it('drops lone surrogates and keeps whole emoji', () => {
    expect(wellFormed(`hi ${HALF_HIGH} there 😀 ${HALF_LOW}!`)).toBe('hi  there 😀 !')
    // JSON of the result is valid for Postgres jsonb (no lone \ud83d escapes)
    expect(JSON.stringify(wellFormed(`x${HALF_HIGH}`))).toBe('"x"')
  })
  it('cleans nested values and keys, leaves numbers and nulls', () => {
    expect(deepWellFormed({ [`a${HALF_LOW}`]: [`b${HALF_HIGH}`, 3, null, { c: `😀${HALF_HIGH}` }] })).toEqual({ a: ['b', 3, null, { c: '😀' }] })
  })
  it('clip never ends on half an emoji', () => {
    expect(clip('ab😀', 3)).toBe('ab')
    expect(clip('ab😀', 4)).toBe('ab😀')
    expect(clip('abc', 10)).toBe('abc')
  })
})
