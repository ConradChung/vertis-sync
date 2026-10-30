// Stage 7 (output): the run's counts and each influencer's yield + cost from
// this run, for influencer_runs.counts and influencers.last_*. Pure.

export interface StatReactor {
  reacted_to: string[]
  triage: string | null
  verdict: string | null
  door_count: number | null
  pplx_cost_usd: number | string | null
  influencer_count: number
  first_seen_run: string | null
  verified_run: string | null
}

export interface StatInfluencer { id: string; slug: string }
export interface StatApify { influencer_id: string; kind: string; status: string; cost_usd: number | string; item_count: number | null }
export interface StatPosts { influencer_id: string; posts: number; top: number }

export const DOORS_700 = 700

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const r4 = (v: number) => Math.round(v * 10_000) / 10_000

export function runCounts(runId: string, reactors: StatReactor[]) {
  const verified = reactors.filter((r) => r.verdict === 'verified')
  return {
    unique_reactors: reactors.length,
    new_reactors: reactors.filter((r) => r.first_seen_run === runId).length,
    known_reactors: reactors.filter((r) => r.first_seen_run !== runId).length,
    candidates: reactors.filter((r) => r.triage === 'likely' || r.triage === 'possible').length,
    verified: verified.length,
    verified_this_run: verified.filter((r) => r.verified_run === runId).length,
    rejected: reactors.filter((r) => r.verdict === 'rejected').length,
    verify_errors: reactors.filter((r) => r.verdict === 'error').length,
    unverified_candidates: reactors.filter((r) => (r.triage === 'likely' || r.triage === 'possible') && r.verdict === null).length,
    with_door_count: verified.filter((r) => r.door_count !== null).length,
    leads_700: verified.filter((r) => (r.door_count ?? 0) >= DOORS_700).length,
  }
}

/** Per influencer: posts, reactions, reactors and leads that reacted to them this run, and this run's cost share. */
export function influencerStats(
  runId: string,
  influencers: StatInfluencer[],
  reactors: StatReactor[],
  apify: StatApify[],
  posts: StatPosts[],
  haikuUsd: number,
) {
  const totalReactors = reactors.length || 1
  return influencers.map((inf) => {
    const mine = reactors.filter((r) => r.reacted_to.includes(inf.slug))
    const leads = mine.filter((r) => r.verdict === 'verified')
    const ap = apify.filter((a) => a.influencer_id === inf.id)
    const apifyUsd = ap.reduce((s, a) => s + n(a.cost_usd), 0)
    const reactions = ap.filter((a) => a.kind === 'reactions').reduce((s, a) => s + n(a.item_count), 0)
    const pplx = mine
      .filter((r) => r.verified_run === runId)
      .reduce((s, r) => s + n(r.pplx_cost_usd) / Math.max(1, r.influencer_count), 0)
    const haiku = haikuUsd * (mine.length / totalReactors)
    const p = posts.find((x) => x.influencer_id === inf.id)
    return {
      id: inf.id,
      slug: inf.slug,
      last_posts: p?.posts ?? 0,
      last_top_posts: p?.top ?? 0,
      last_reactions: reactions,
      last_reactors: mine.length,
      last_leads: leads.length,
      last_leads_700: leads.filter((r) => (r.door_count ?? 0) >= DOORS_700).length,
      last_apify_usd: r4(apifyUsd),
      last_perplexity_usd: r4(pplx),
      last_haiku_usd: r4(haiku),
      last_cost_usd: r4(apifyUsd + pplx + haiku),
    }
  })
}
