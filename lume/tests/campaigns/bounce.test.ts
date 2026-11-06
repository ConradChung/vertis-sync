import { describe, expect, it } from 'vitest'
import { bounceRate, bounceTone, BOUNCE_TONE_TEXT } from '@/lib/campaigns/bounce'

describe('bounceRate', () => {
  it('is bounced ÷ sent as a percent, one decimal', () => {
    expect(bounceRate(3, 200)).toBe(1.5)
    expect(bounceRate(1, 3)).toBe(33.3)
    expect(bounceRate(0, 50)).toBe(0)
  })
  it('is null when nothing was sent or either number is unknown', () => {
    expect(bounceRate(0, 0)).toBeNull()
    expect(bounceRate(null, 100)).toBeNull()
    expect(bounceRate(2, null)).toBeNull()
    expect(bounceRate(undefined, undefined)).toBeNull()
  })
})

describe('bounceTone', () => {
  it('green under 2 %, amber 2-5 %, red over 5 %', () => {
    expect(bounceTone(0)).toBe('green')
    expect(bounceTone(1.9)).toBe('green')
    expect(bounceTone(2)).toBe('amber')
    expect(bounceTone(5)).toBe('amber')
    expect(bounceTone(5.1)).toBe('red')
    expect(bounceTone(null)).toBe('none')
  })
  it('each tone has a text class', () => {
    expect(BOUNCE_TONE_TEXT.red).toBe('text-red')
    expect(BOUNCE_TONE_TEXT.none).toBe('text-fg-24')
  })
})
