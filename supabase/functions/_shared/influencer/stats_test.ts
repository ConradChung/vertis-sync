import { assertEquals } from 'jsr:@std/assert@1'
import { influencerStats, runCounts, type StatReactor } from './stats.ts'

const RUN = 'run-1'
const rx = (o: Partial<StatReactor>): StatReactor => ({
  reacted_to: ['a'], triage: 'no', verdict: null, door_count: null, pplx_cost_usd: 0, influencer_count: 1,
  first_seen_run: RUN, verified_run: null, ...o,
})

Deno.test('runCounts: new vs known, candidates, verified, doors, 700+', () => {
  const c = runCounts(RUN, [
    rx({}),
    rx({ first_seen_run: 'old', triage: 'likely', verdict: 'verified', door_count: 900, verified_run: 'old' }),
    rx({ triage: 'possible', verdict: 'verified', door_count: 300, verified_run: RUN }),
    rx({ triage: 'likely', verdict: 'rejected', verified_run: RUN }),
    rx({ triage: 'likely' }),
  ])
  assertEquals(c, {
    unique_reactors: 5, new_reactors: 4, known_reactors: 1, candidates: 4, verified: 2, verified_this_run: 1, rejected: 1,
    verify_errors: 0, unverified_candidates: 1, with_door_count: 2, leads_700: 1,
  })
})

Deno.test('influencerStats: yield per influencer, Apify cost, Perplexity split by influencer_count, Haiku pro rata', () => {
  const reactors = [
    rx({ reacted_to: ['a', 'b'], influencer_count: 2, verdict: 'verified', door_count: 800, pplx_cost_usd: 0.01, verified_run: RUN }),
    rx({ reacted_to: ['a'], verdict: 'verified', door_count: null, pplx_cost_usd: 0.004, verified_run: 'old' }),
    rx({ reacted_to: ['b'] }),
    rx({ reacted_to: ['b'] }),
  ]
  const out = influencerStats(RUN, [{ id: 'A', slug: 'a' }, { id: 'B', slug: 'b' }], reactors, [
    { influencer_id: 'A', kind: 'posts', status: 'succeeded', cost_usd: '0.2', item_count: 100 },
    { influencer_id: 'A', kind: 'reactions', status: 'succeeded', cost_usd: 1.5, item_count: 1000 },
  ], [{ influencer_id: 'A', posts: 100, top: 10 }], 0.04)
  assertEquals(out[0], {
    id: 'A', slug: 'a', last_posts: 100, last_top_posts: 10, last_reactions: 1000, last_reactors: 2, last_leads: 2, last_leads_700: 1,
    last_apify_usd: 1.7, last_perplexity_usd: 0.005, last_haiku_usd: 0.02, last_cost_usd: 1.725,
  })
  assertEquals([out[1].last_reactors, out[1].last_leads, out[1].last_apify_usd, out[1].last_posts], [3, 1, 0, 0])
})
