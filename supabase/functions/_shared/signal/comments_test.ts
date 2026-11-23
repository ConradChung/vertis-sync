// Run: deno test _shared/signal/comments_test.ts
import { assertEquals } from 'jsr:@std/assert@1'
import { commentersToConsider, firstName, linkedinKey, normalizeProfileUrl, parseComments } from './comments.ts'
import fixture from './fixtures/post-comments.json' with { type: 'json' }

Deno.test('parser: fixture comments, nested reply, reply items; junk dropped', () => {
  const cs = parseComments(fixture as unknown[])
  assertEquals(cs.length, 4)
  const dana = cs[0]
  assertEquals(dana.linkedin_id, 'ACoAAFsE9LEBl7BKtsoGeoDZz0IvKfmiGgiEtX8')
  assertEquals(dana.linkedin_url, 'https://www.linkedin.com/in/dana-whitfield-3a94a6367')
  assertEquals(dana.name, 'Dana Whitfield, CPM')
  assertEquals(dana.first_name, 'Dana')
  assertEquals(dana.headline, 'Owner at Whitfield Property Management')
  assertEquals(dana.comment_text, 'Great point on owner reporting. We switched last year.')
  assertEquals(dana.commented_at, '2026-11-22T17:31:58.534Z')
  assertEquals(dana.comment_url?.startsWith('https://www.linkedin.com/feed/update/urn:li:activity:7328838056403173380?commentUrn='), true)
  assertEquals(dana.post_id, '7328838056403173380')
  assertEquals(dana.is_author, false)
  // nested reply by Frank
  assertEquals(cs[1].is_author, true)
  // timestamp-only date, honorific skipped, host normalised
  assertEquals(cs[2].commented_at, new Date(1795400000000).toISOString())
  assertEquals(cs[2].first_name, 'Luis')
  assertEquals(cs[2].linkedin_url, 'https://www.linkedin.com/in/luis-ortega-pm')
  // no profile URL: falls back to the id
  assertEquals(cs[3].linkedin_url, 'https://www.linkedin.com/in/ACoAACCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC')
})

Deno.test('Frank is skipped (author flag or his slug); people are unique', () => {
  const cs = parseComments(fixture as unknown[])
  const keep = commentersToConsider([...cs, { ...cs[0] }, { ...cs[2], is_author: false, linkedin_url: 'https://www.linkedin.com/in/frank22' }], {
    profileUrl: 'https://www.linkedin.com/in/frank22/',
  })
  assertEquals(keep.map((c) => c.first_name), ['Dana', 'Luis', 'Pat'])
})

Deno.test('url helpers', () => {
  assertEquals(normalizeProfileUrl('http://linkedin.com/in/Jane-Doe/?x=1'), 'https://www.linkedin.com/in/jane-doe')
  assertEquals(normalizeProfileUrl('https://www.linkedin.com/company/acme'), null)
  assertEquals(linkedinKey('https://www.linkedin.com/in/Jane-Doe/'), 'in/jane-doe')
  assertEquals(firstName('  '), null)
  assertEquals(firstName('Mr. bob smith'), 'Bob')
})
