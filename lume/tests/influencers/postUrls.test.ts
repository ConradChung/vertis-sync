import { describe, expect, it } from 'vitest'
import { checkPostUrls, normalizePostUrl } from '@/lib/influencers/postUrls'

const POST = 'https://www.linkedin.com/posts/pslohmann_property-management-activity-7250000000000000000-AbCd'
const URN = 'https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000'

describe('normalizePostUrl', () => {
  it('accepts /posts/ and /feed/update/ URNs, stripping query, hash and trailing slash', () => {
    expect(normalizePostUrl(POST)).toBe(POST)
    expect(normalizePostUrl(`${POST}/?utm_source=share&utm_medium=member_desktop#comments`)).toBe(POST)
    expect(normalizePostUrl(`  ${URN}/  `)).toBe(URN)
    expect(normalizePostUrl('https://linkedin.com/feed/update/urn:li:ugcPost:123')).toBe('https://linkedin.com/feed/update/urn:li:ugcPost:123')
    expect(normalizePostUrl('https://www.linkedin.com/feed/update/urn:li:share:42')).toBe('https://www.linkedin.com/feed/update/urn:li:share:42')
    expect(normalizePostUrl('https://www.linkedin.com/posts/a%20b_x-1')).toBe('https://www.linkedin.com/posts/a%20b_x-1')
  })
  it('rejects anything else', () => {
    for (const bad of [
      'http://www.linkedin.com/posts/abc',
      'https://www.linkedin.com/in/pslohmann',
      'https://www.linkedin.com/feed/update/urn:li:comment:1',
      'https://www.linkedin.com/feed/update/urn:li:activity:abc',
      'https://evil.com/posts/abc',
      'https://www.linkedin.com.evil.com/posts/abc',
      'https://www.linkedin.com/posts/abc/extra',
      '',
    ]) {
      expect(normalizePostUrl(bad), bad).toBeNull()
    }
  })
})

describe('checkPostUrls', () => {
  it('normalizes and dedupes, keeping order', () => {
    expect(checkPostUrls([URN, POST, `${URN}/?x=1`])).toEqual({ ok: true, urls: [URN, POST] })
  })
  it('refuses empty, non-arrays, bad URLs and more than 10 posts', () => {
    expect(checkPostUrls([])).toMatchObject({ ok: false })
    expect(checkPostUrls('nope')).toMatchObject({ ok: false })
    expect(checkPostUrls([POST, 'https://www.linkedin.com/in/x'])).toMatchObject({ ok: false, error: expect.stringMatching(/invalid post_urls.*linkedin\.com\/in\/x/) })
    const eleven = Array.from({ length: 11 }, (_, i) => `https://www.linkedin.com/feed/update/urn:li:activity:${i + 1}`)
    expect(checkPostUrls(eleven)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 10/) })
    expect(checkPostUrls(eleven.slice(0, 10))).toMatchObject({ ok: true })
  })
})
