// Run: deno test _shared/signal/dedupe_test.ts
import { assertEquals } from 'jsr:@std/assert@1'
import type { Commenter } from './comments.ts'
import { dedupeCommenters } from './dedupe.ts'
import { FakeStore, person } from './testkit.ts'

const c = (slug: string, id: string | null, p: Partial<Commenter> = {}): Commenter => ({
  linkedin_id: id, linkedin_url: `https://www.linkedin.com/in/${slug}`, name: 'X Y', first_name: 'X', headline: 'Owner at PM Co',
  comment_text: 'nice', commented_at: '2026-11-23T18:00:00Z', comment_url: 'https://www.linkedin.com/feed/update/x', post_id: 'p1', is_author: false, ...p,
})

function store() {
  const s = new FakeStore()
  s.posts.push({ post_id: 'p1', post_url: 'u', posted_at: '2026-11-23T10:00:00Z', likes: 1, comment_count: 3, comments_pulled_at_count: 0, last_comments_pull_at: null, digest_status: null })
  s.posts.push({ post_id: 'p0', post_url: 'u0', posted_at: '2026-11-20T10:00:00Z', likes: 1, comment_count: 3, comments_pulled_at_count: 0, last_comments_pull_at: null, digest_status: 'posted' })
  return s
}

Deno.test('dedupe: id match and URL match against signal_people → no new row', async () => {
  const s = store()
  s.people.push(person({ id: 1, linkedin_id: 'ID1', linkedin_url: 'https://www.linkedin.com/in/a', stage: 'ready', kind: 'commenter' }))
  s.people.push(person({ id: 2, linkedin_id: null, linkedin_url: 'https://www.linkedin.com/in/b', stage: 'skipped', kind: 'commenter' }))
  const out = await dedupeCommenters(s, [c('a-renamed', 'ID1'), c('b', 'NEWID')], 'p1')
  assertEquals(out, { new: 0, skipped: 0, existing: 2, upgraded: 0 })
  assertEquals(s.people.length, 2)
})

Deno.test('dedupe: known in Lume (reactor verdict, portal URL, list key) and exported → skipped rows', async () => {
  const s = store()
  s.reactors.push({ linkedin_id: 'R1', linkedin_url: 'https://www.linkedin.com/in/ACoR1', verdict: 'rejected', exported_at: null })
  s.reactors.push({ linkedin_id: null, linkedin_url: 'https://www.linkedin.com/in/exp/', verdict: 'verified', exported_at: '2026-11-01T00:00:00Z' })
  s.reactors.push({ linkedin_id: 'R3', linkedin_url: 'https://www.linkedin.com/in/fresh-reactor', verdict: null, exported_at: null })
  s.lumeUrls.push('https://linkedin.com/in/portal-lead')
  s.lumeKeys.push('in/list-lead')
  const out = await dedupeCommenters(s, [
    c('someone', 'R1'), c('exp', null), c('portal-lead', null), c('List-Lead', null), c('fresh-reactor', 'R3'), c('brand-new', 'N1'),
  ], 'p1')
  assertEquals(out, { new: 2, skipped: 4, existing: 0, upgraded: 0 })
  const by = (slug: string) => s.bySlug(slug)!
  assertEquals([by('someone').stage, by('someone').skip_reason], ['skipped', 'known_in_lume'])
  assertEquals(by('exp').skip_reason, 'exported')
  assertEquals(by('portal-lead').skip_reason, 'known_in_lume')
  assertEquals(by('list-lead').skip_reason, 'known_in_lume')
  // A reactor with no verdict and no export isn't "known": the commenter is new.
  assertEquals([by('fresh-reactor').stage, by('fresh-reactor').kind], ['triage', 'commenter'])
  assertEquals([by('brand-new').stage, by('brand-new').comment_text, by('brand-new').post_id], ['triage', 'nice', 'p1'])
})

Deno.test('dedupe: commenter wins over an un-alerted reactor; not over an alerted one or a posted digest', async () => {
  const s = store()
  s.people.push(person({ id: 1, linkedin_id: 'RA', linkedin_url: 'https://www.linkedin.com/in/ra', kind: 'reactor', stage: 'ready', post_id: 'p1', alert_status: null }))
  s.people.push(person({ id: 2, linkedin_id: 'RB', linkedin_url: 'https://www.linkedin.com/in/rb', kind: 'reactor', stage: 'alerted', post_id: 'p1', alert_status: 'posted' }))
  s.people.push(person({ id: 3, linkedin_id: 'RC', linkedin_url: 'https://www.linkedin.com/in/rc', kind: 'reactor', stage: 'ready', post_id: 'p0', alert_status: null }))
  const out = await dedupeCommenters(s, [c('ra', 'RA', { comment_text: 'love this' }), c('rb', 'RB'), c('rc', 'RC')], 'p1')
  assertEquals(out, { new: 0, skipped: 0, existing: 2, upgraded: 1 })
  const ra = s.get(1)
  assertEquals([ra.kind, ra.comment_text, ra.post_id, ra.stage], ['commenter', 'love this', 'p1', 'draft'])
  assertEquals(s.get(2).kind, 'reactor')
  assertEquals(s.get(3).kind, 'reactor')
})
