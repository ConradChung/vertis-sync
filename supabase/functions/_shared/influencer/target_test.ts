// Run: deno test _shared/influencer/target_test.ts
import { assertEquals } from 'jsr:@std/assert@1'
import { normalizePostUrl, postIdFromUrl, targetPostRows } from './posts.ts'

const LOHMANN = 'https://www.linkedin.com/posts/pslohmann_working-on-the-14-most-interesting-people-share-7524216718781599744-lKM4'

Deno.test('normalizePostUrl: keeps post URLs, drops query/hash/trailing slash, adds www', () => {
  assertEquals(normalizePostUrl(`${LOHMANN}/?utm_source=share&utm_medium=member_ios#x`), LOHMANN)
  assertEquals(normalizePostUrl(LOHMANN.replace('www.', '')), LOHMANN)
  assertEquals(normalizePostUrl('https://www.linkedin.com/feed/update/urn:li:activity:7524482949531021313/'),
    'https://www.linkedin.com/feed/update/urn:li:activity:7524482949531021313')
})

Deno.test('normalizePostUrl: rejects profiles, short links, other hosts, http, junk', () => {
  for (const bad of [
    'https://www.linkedin.com/in/pslohmann', 'https://lnkd.in/p/eBDQ2dEq', 'http://www.linkedin.com/posts/a_b-share-1',
    'https://evil.com/posts/x', 'https://www.linkedin.com/posts/../in/x', '', 42, null, `https://www.linkedin.com/posts/${'a'.repeat(600)}`,
  ]) assertEquals(normalizePostUrl(bad), null, String(bad))
})

Deno.test('postIdFromUrl: activity/share/ugcPost number, else the slug', () => {
  assertEquals(postIdFromUrl(LOHMANN), '7524216718781599744')
  assertEquals(postIdFromUrl('https://www.linkedin.com/posts/x_y-activity-7524482949531021313-06rs'), '7524482949531021313')
  assertEquals(postIdFromUrl('https://www.linkedin.com/feed/update/urn:li:ugcPost:7400000000000000001'), '7400000000000000001')
  assertEquals(postIdFromUrl('https://www.linkedin.com/posts/just-a-slug'), 'just-a-slug')
})

Deno.test('targetPostRows: ranked in order, marked relevant, likes unknown (0)', () => {
  const rows = targetPostRows('run', 'inf', [LOHMANN, 'https://www.linkedin.com/posts/just-a-slug'])
  assertEquals(rows.map((r) => [r.rank, r.post_id, r.pm_relevant, r.likes]), [
    [1, '7524216718781599744', true, 0],
    [2, 'just-a-slug', true, 0],
  ])
  assertEquals(rows[0].post_url, LOHMANN)
})
