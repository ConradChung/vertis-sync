// Cost model for the PM influencer reactions pipeline. Pure.
//
// Unit prices (verified 2026-10-06, unchanged on the 2026-10-08 full run):
//   harvestapi~linkedin-profile-posts    $2.00 per 1,000 posts
//   harvestapi~linkedin-post-reactions   $1.50 per 1,000 reactions
//   Perplexity Sonar (low context)       ~$0.006 per call (request fee dominates)
//   Claude Haiku 5.5                     $0.10 / $0.50 per million input / output tokens
//
// Apify runs carry maxTotalChargeUsd, so the reservation the budget gate
// holds is a true upper bound: posts reserve 1.5x the influencer's last post
// count (300 when unknown) + 10 cents; reactions reserve the exact stage-2
// bill + 10% + 5 cents.

export const POSTS_ACTOR = 'harvestapi~linkedin-profile-posts'
export const REACTIONS_ACTOR = 'harvestapi~linkedin-post-reactions'
export const PRICE_PER_1K_POSTS = 2
export const PRICE_PER_1K_REACTIONS = 1.5
export const PPLX_CALL_USD = 0.006
export const HAIKU_IN_PER_M = 0.1
export const HAIKU_OUT_PER_M = 0.5
export const APIFY_RUN_MAX_USD = 20
export const DEFAULT_MAX_REACTIONS_PER_POST = 1000
export const TOP_POSTS = 10

const ceilCents = (n: number) => Math.ceil(n * 100 - 1e-9) / 100
const round4 = (n: number) => Math.round(n * 10_000) / 10_000
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000

/** Exact reactions bill for a set of top posts: sum(min(likes, cap)) at $1.5/1k (cap 0 = uncapped). */
export function estimateReactions(top: { likes?: number | null }[], cap: number): { reactions: number; usd: number } {
  let reactions = 0
  for (const p of top) {
    const likes = Math.max(0, Math.floor(Number(p.likes ?? 0) || 0))
    reactions += cap > 0 ? Math.min(likes, cap) : likes
  }
  return { reactions, usd: Math.round(reactions * PRICE_PER_1K_REACTIONS / 1000 * 100) / 100 }
}

export function reactionsMaxChargeUsd(estimateUsd: number): number {
  return Math.min(APIFY_RUN_MAX_USD, ceilCents(Math.max(0, estimateUsd) * 1.1 + 0.05))
}

export function postsReserveUsd(lastPosts: number | null | undefined): number {
  const posts = (lastPosts === null || lastPosts === undefined ? 300 : Math.max(0, lastPosts)) * 1.5
  return Math.min(APIFY_RUN_MAX_USD, ceilCents(posts * PRICE_PER_1K_POSTS / 1000 + 0.1))
}

/** What a finished Apify run cost: the larger of Apify's usageTotalUsd and items x the per-item price. */
export function apifyActualUsd(run: { usageTotalUsd?: unknown }, items: number, pricePer1k: number): number {
  const usage = typeof run.usageTotalUsd === 'number' && Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd >= 0 ? run.usageTotalUsd : 0
  return round4(Math.max(usage, Math.max(0, items) * pricePer1k / 1000))
}

export function haikuUsd(usage: { input_tokens?: number; output_tokens?: number } | null | undefined): number {
  if (!usage) return 0
  const i = Number(usage.input_tokens ?? 0) || 0
  const o = Number(usage.output_tokens ?? 0) || 0
  return round6((i * HAIKU_IN_PER_M + o * HAIKU_OUT_PER_M) / 1_000_000)
}
