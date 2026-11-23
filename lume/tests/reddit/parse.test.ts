import { describe, expect, it } from 'vitest'
import { authorFromContext, dmHandle, extractRedditLinks, findKeyword, htmlToText, isHot, parseRedditJson } from '@/lib/reddit/parse'
import { COMMENT_JSON, HTML, PLAIN, POST_JSON } from './fixtures'

describe('extractRedditLinks', () => {
  it('finds a post and a comment link with canonical keys', () => {
    const links = extractRedditLinks(PLAIN)
    expect(links.map((l) => [l.kind, l.key])).toEqual([
      ['post', 'https://www.reddit.com/r/propertymanagement/comments/1gx2abc/_/'],
      ['comment', 'https://www.reddit.com/r/landlord/comments/1gx3def/_/lyq9xyz/'],
    ])
    expect(links[0].url).toBe('https://www.reddit.com/r/PropertyManagement/comments/1gx2abc/looking_for_alternatives_to_appfolio/')
    expect(links[1].commentId).toBe('lyq9xyz')
    expect(links[1].subreddit).toBe('Landlord')
  })

  it("keeps F5Bot's own text around the link as context, not the neighbour's link", () => {
    const [post, comment] = extractRedditLinks(PLAIN)
    expect(post.context).toContain('Looking for alternatives to AppFolio')
    expect(post.context).toContain('fees keep going up')
    expect(comment.context).toContain('support is slow')
    expect(comment.context).not.toContain('reddit.com/r/PropertyManagement')
  })

  it('finds URL-encoded links inside an HTML redirect', () => {
    const links = extractRedditLinks('', HTML)
    expect(links).toHaveLength(1)
    expect(links[0].key).toBe('https://www.reddit.com/r/propertymanagement/comments/1gx2abc/_/')
  })

  it('dedupes the same thing across plain, HTML, case and slug', () => {
    const variant = PLAIN.replace('/r/PropertyManagement/comments/1gx2abc/looking_for_alternatives_to_appfolio/', '/r/propertymanagement/comments/1GX2ABC/other_slug/')
    const links = extractRedditLinks(`${PLAIN}\n${variant}`, HTML)
    expect(links).toHaveLength(2)
  })

  it('ignores non-thread links and empty input', () => {
    expect(extractRedditLinks('see https://www.reddit.com/r/landlord/ and https://f5bot.com')).toEqual([])
    expect(extractRedditLinks('')).toEqual([])
  })

  it('caps at 20 links', () => {
    const many = Array.from({ length: 30 }, (_, i) => `https://www.reddit.com/r/landlord/comments/abc${100 + i}/t/`).join('\n')
    expect(extractRedditLinks(many)).toHaveLength(20)
  })
})

describe('parseRedditJson', () => {
  it('reads a post', () => {
    const t = parseRedditJson(POST_JSON, { commentId: null })
    expect(t).toMatchObject({ author: 'small_pm_owner', subreddit: 'PropertyManagement', title: 'Looking for alternatives to AppFolio for 200 units' })
    expect(t?.text).toContain('switching from')
    expect(t?.createdAt).toBe(new Date(1763900000 * 1000).toISOString())
  })
  it('reads the linked comment, with the thread title', () => {
    const t = parseRedditJson(COMMENT_JSON, { commentId: 'lyq9xyz' })
    expect(t).toMatchObject({ author: 'rental_rita', subreddit: 'Landlord', title: 'Best software for a small portfolio?', text: 'Buildium has been fine for us, support is slow though.' })
  })
  it('null on junk or a missing comment', () => {
    expect(parseRedditJson({ nope: 1 }, { commentId: null })).toBeNull()
    expect(parseRedditJson(COMMENT_JSON, { commentId: 'zzz999' })).toBeNull()
  })
})

describe('keyword, hot, handle', () => {
  it('finds the tracked keyword case-insensitively', () => {
    expect(findKeyword('We use AppFolio')).toBe('appfolio')
    expect(findKeyword(null, 'BUILDIUM rocks')).toBe('buildium')
    expect(findKeyword('Yardi')).toBeNull()
  })
  it('tags complaint / switching language', () => {
    expect(isHot('Thinking of switching from AppFolio')).toBe(true)
    expect(isHot('Any alternatives to Buildium?')).toBe(true)
    expect(isHot('We are migrating next month')).toBe(true)
    expect(isHot('Buildium works fine for us')).toBe(false)
  })
  it('only DM-able handles', () => {
    expect(dmHandle('rental_rita')).toBe('rental_rita')
    expect(dmHandle('[deleted]')).toBeNull()
    expect(dmHandle('AutoModerator')).toBeNull()
    expect(dmHandle('x')).toBeNull()
    expect(dmHandle(null)).toBeNull()
  })
  it('htmlToText drops tags and decodes entities', () => {
    expect(htmlToText('<p>a &amp; b<br>c</p>')).toBe('a & b\nc')
  })
})

describe('authorFromContext', () => {
  it('reads a profile link, u/name or "by name"', () => {
    expect(authorFromContext('posted by https://www.reddit.com/user/rental_rita/ in r/Landlord')).toBe('rental_rita')
    expect(authorFromContext('/r/Landlord u/small_pm_owner: switching')).toBe('small_pm_owner')
    expect(authorFromContext('Comment by rental_rita on Best software')).toBe('rental_rita')
  })
  it('null when F5Bot names nobody', () => {
    expect(authorFromContext('Keyword: appfolio /r/PropertyManagement: Looking for alternatives')).toBeNull()
  })
})
