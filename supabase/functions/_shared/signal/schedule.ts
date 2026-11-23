// GTM-14 comments lane: when to poll Frank's posts and pull a post's comments. Pure.
import { buildPostsInput } from '../influencer/posts.ts'

export const POSTS_ACTOR = 'harvestapi~linkedin-profile-posts'
export const COMMENTS_ACTOR = 'harvestapi~linkedin-post-comments'
/** Both actors charge $2 per 1,000 results (comments: "post-comment" event, $0.002 on FREE..SILVER). */
export const PRICE_PER_1K = 2
export const ITEM_USD = 0.002
export const RUN_BASE_USD = 0.01
export const POSTS_MAX = 20
export const COMMENTS_MAX = 100

const H = 3_600_000
const D = 24 * H
export const WINDOW_MS = 7 * D
export const POSTS_7D_EVERY_MS = 6 * H
export const POSTS_48H_EVERY_MS = 25 * 60_000

export type PostsKind = 'posts_7d' | 'posts_48h'

const older = (iso: string | null | undefined, now: Date, ms: number) =>
  !iso || !Number.isFinite(Date.parse(iso)) || now.getTime() - Date.parse(iso) > ms

/** Which posts polls are due this tick (7 d sweep every 6 h, 48 h sweep every 25 min; force overrides). */
export function postsDue(
  state: { last_posts_7d_at: string | null; last_posts_48h_at: string | null },
  now: Date,
  force: { posts_7d?: boolean; posts_48h?: boolean } = {},
): PostsKind[] {
  const out: PostsKind[] = []
  if (force.posts_7d || older(state.last_posts_7d_at, now, POSTS_7D_EVERY_MS)) out.push('posts_7d')
  // The 7 d sweep covers the last 48 h too: no second run in the same tick unless forced.
  if (force.posts_48h || (!out.includes('posts_7d') && older(state.last_posts_48h_at, now, POSTS_48H_EVERY_MS))) out.push('posts_48h')
  return out
}

/** harvestapi~linkedin-profile-posts input (buildPostsInput's shape), postedLimitDate = now − 7 d or 48 h. */
export function postsInput(profileUrl: string, kind: PostsKind, now: Date): Record<string, unknown> {
  const base = buildPostsInput(profileUrl, 7, now)
  const since = new Date(now.getTime() - (kind === 'posts_7d' ? 7 * D : 2 * D))
  return { ...base, maxPosts: POSTS_MAX, postedLimitDate: since.toISOString().slice(0, 10), scrapeComments: false, scrapeReactions: false }
}

const cents = (n: number) => Math.ceil(n * 100 - 1e-9) / 100

export const postsReserveUsd = () => cents(ITEM_USD * POSTS_MAX + RUN_BASE_USD)

export interface PostSched {
  post_id: string
  posted_at: string
  comment_count: number
  comments_pulled_at_count: number
  last_comments_pull_at: string | null
}

export type PullDecision = { due: true; maxItems: number; postedLimit: '24h' | 'week' } | { due: false; reason: string }

/**
 * Pull a post's comments only when its count rose and either it is under
 * 48 h old (every tick), or 2–7 d old and last pulled over 24 h ago. Never
 * past 7 d, and never for a post that was already over 7 d old when the lane
 * first ran (no backlog).
 */
export function commentsPull(post: PostSched, now: Date, firstRunAt: string | null): PullDecision {
  const posted = Date.parse(post.posted_at)
  if (!Number.isFinite(posted)) return { due: false, reason: 'no_date' }
  const age = now.getTime() - posted
  if (age > WINDOW_MS) return { due: false, reason: 'too_old' }
  if (firstRunAt && Number.isFinite(Date.parse(firstRunAt)) && posted < Date.parse(firstRunAt) - WINDOW_MS) return { due: false, reason: 'backlog' }
  const delta = post.comment_count - post.comments_pulled_at_count
  if (delta <= 0) return { due: false, reason: 'no_new_comments' }
  if (age >= 2 * D && !older(post.last_comments_pull_at, now, D)) return { due: false, reason: 'pulled_within_24h' }
  return { due: true, maxItems: Math.min(COMMENTS_MAX, delta + 10), postedLimit: age < D ? '24h' : 'week' }
}

export function commentsInput(postUrl: string, d: { maxItems: number; postedLimit: '24h' | 'week' }): Record<string, unknown> {
  return { posts: [postUrl], maxItems: d.maxItems, postedLimit: d.postedLimit, scrapeReplies: true, profileScraperMode: 'short' }
}

export const commentsReserveUsd = (maxItems: number) => cents(maxItems * ITEM_USD + RUN_BASE_USD)

/** Posts the lane may keep: posted within the last 7 days. */
export const inWindow = (postedAt: string | null, now: Date) =>
  !!postedAt && Number.isFinite(Date.parse(postedAt)) && now.getTime() - Date.parse(postedAt) <= WINDOW_MS
