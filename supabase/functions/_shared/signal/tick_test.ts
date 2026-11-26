// Run: deno test _shared/signal/tick_test.ts
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { runTick, type TickDeps } from './tick.ts'
import { FACTS, FakeApify, Fakes, FakeStore } from './testkit.ts'
import comments from './fixtures/post-comments.json' with { type: 'json' }

const NOW = Date.parse('2026-11-23T20:00:00Z')
const postItem = (id: string, hoursAgo: number, commentsN: number) => ({
  type: 'post', id, linkedinUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${id}`, content: 'PM ops thoughts',
  postedAt: { date: new Date(NOW - hoursAgo * 3_600_000).toISOString() }, engagement: { likes: 10, comments: commentsN },
})

function deps(s: FakeStore, a: FakeApify, f: Fakes, ingested = { n: 0 }): TickDeps {
  let t = NOW
  return {
    store: s, apify: a, rest: () => Promise.reject(new Error('unused')),
    ingestReactorRuns: () => Promise.resolve({ ingested: ingested.n }),
    haiku: f.haiku, perplexity: f.perplexity, crawl: f.crawl, email: f.email, facts: FACTS,
    clock: () => (t += 10), uuid: () => 'tok',
  }
}

Deno.test('tick: leased → skipped', async () => {
  const s = new FakeStore()
  s.lease = true
  assertEquals(await runTick(deps(s, new FakeApify(), new Fakes())), { ok: true, skipped: 'leased' })
})

Deno.test('tick: first run polls posts, pulls comments, dedupes (Frank skipped), filters to ready', async () => {
  const s = new FakeStore()
  const a = new FakeApify()
  // post 7328838056403173380 (the fixture's post) is 5 h old; an 8-day-old post is ignored (no backlog)
  a.posts = [postItem('7328838056403173380', 5, 3), postItem('999', 24 * 8, 40)]
  a.comments = comments
  const f = new Fakes()
  const out = await runTick(deps(s, a, f)) as Record<string, unknown>
  assertEquals(out.ok, true)
  assert(s.state_.first_run_at)
  assertEquals(a.started.map((x) => x.actor), ['harvestapi~linkedin-profile-posts', 'harvestapi~linkedin-post-comments'])
  assertEquals(a.started[0].max, 0.05)
  assertEquals(a.started[1].input.maxItems, 13)
  assertEquals(s.posts.map((p) => p.post_id), ['7328838056403173380'])
  assertEquals([s.posts[0].comments_pulled_at_count, !!s.posts[0].last_comments_pull_at], [3, true])
  // Dana, Luis, Pat; not Frank
  assertEquals(s.people.length, 3)
  assertEquals(s.people.some((p) => p.linkedin_url.endsWith('/frank22')), false)
  assertEquals(s.people.filter((p) => p.stage === 'ready').length, 3)
  // Apify reservations settled to max(usageTotalUsd, items × $0.002)
  const apify = s.spend.filter((x) => x.lane === 'comments_apify')
  assertEquals(apify.map((x) => [x.kind, x.status, x.usd]), [['posts_7d', 'settled', 0.004], ['comments', 'settled', 0.01]])
  const counts = out.counts as Record<string, number>
  assertEquals(counts.ready, 3)
  assertEquals(counts.commenters_new, 3)
})

Deno.test('tick: unfinished runs are collected by the next tick; no duplicate comment pull meanwhile', async () => {
  const s = new FakeStore()
  const a = new FakeApify()
  a.finish = false
  a.posts = [postItem('7328838056403173380', 5, 3)]
  a.comments = comments
  const f = new Fakes()
  await runTick(deps(s, a, f))
  assertEquals(s.posts.length, 0)
  assertEquals(s.spend.filter((x) => x.status === 'reserved').length, 1)
  for (const r of a.runs.values()) r.run.status = 'SUCCEEDED'
  a.finish = true
  await runTick(deps(s, a, f)) // collects posts, starts comments
  assertEquals(s.posts.length, 1)
  await runTick(deps(s, a, f))
  assertEquals(a.started.filter((x) => x.actor.includes('comments')).length, 1)
  assertEquals(s.spend.filter((x) => x.status === 'reserved').length, 0)
})

Deno.test('tick: a cap stop is respected and lifts after the window', async () => {
  const s = new FakeStore()
  const a = new FakeApify()
  a.posts = []
  s.state_.stopped_at = new Date(NOW - 3_600_000).toISOString()
  s.state_.stopped_reason = 'daily:2026-11-23 paused'
  const out = await runTick(deps(s, a, new Fakes())) as Record<string, unknown>
  assertEquals(a.started.length, 0)
  assert(String(out.stopped).startsWith('daily:2026-11-23'))
  // next PT day
  const d = deps(s, a, new Fakes())
  let t = Date.parse('2026-11-24T09:00:00Z')
  d.clock = () => (t += 10)
  s.clock = () => t
  const out2 = await runTick(d) as Record<string, unknown>
  assertEquals(out2.stop_cleared, true)
  assertEquals(s.state_.stopped_at, null)
  assertEquals(a.started.length, 1)
})
