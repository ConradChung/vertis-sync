// Run: deno test _shared/signal/schedule_test.ts
import { assertEquals } from 'jsr:@std/assert@1'
import { commentsInput, commentsPull, commentsReserveUsd, postsDue, postsInput, postsReserveUsd, type PostSched } from './schedule.ts'

const NOW = new Date('2026-11-23T20:00:00Z')
const H = 3_600_000
const ago = (h: number) => new Date(NOW.getTime() - h * H).toISOString()
const post = (ageH: number, p: Partial<PostSched> = {}): PostSched => ({
  post_id: '1', posted_at: ago(ageH), comment_count: 5, comments_pulled_at_count: 2, last_comments_pull_at: null, ...p,
})

Deno.test('posts: 7 d sweep every 6 h, 48 h sweep every 25 min, force overrides', () => {
  assertEquals(postsDue({ last_posts_7d_at: null, last_posts_48h_at: null }, NOW), ['posts_7d'])
  assertEquals(postsDue({ last_posts_7d_at: ago(1), last_posts_48h_at: ago(0.5) }, NOW), ['posts_48h'])
  assertEquals(postsDue({ last_posts_7d_at: ago(1), last_posts_48h_at: ago(0.2) }, NOW), [])
  assertEquals(postsDue({ last_posts_7d_at: ago(7), last_posts_48h_at: ago(0.2) }, NOW), ['posts_7d'])
  assertEquals(postsDue({ last_posts_7d_at: ago(1), last_posts_48h_at: ago(0.1) }, NOW, { posts_7d: true, posts_48h: true }), ['posts_7d', 'posts_48h'])
})

Deno.test('posts input: buildPostsInput shape, 20 posts, no comments/reactions; reservation', () => {
  const i = postsInput('https://www.linkedin.com/in/frank22/', 'posts_48h', NOW)
  assertEquals(i.targetUrls, ['https://www.linkedin.com/in/frank22/'])
  assertEquals(i.maxPosts, 20)
  assertEquals(i.postedLimitDate, '2026-11-21')
  assertEquals([i.scrapeComments, i.scrapeReactions], [false, false])
  assertEquals(postsInput('u', 'posts_7d', NOW).postedLimitDate, '2026-11-16')
  assertEquals(postsReserveUsd(), 0.05)
})

Deno.test('comments: < 48 h pulls every tick when the count rose', () => {
  assertEquals(commentsPull(post(3, { last_comments_pull_at: ago(0.1) }), NOW, null), { due: true, maxItems: 13, postedLimit: '24h' })
  assertEquals(commentsPull(post(30, { last_comments_pull_at: ago(0.1) }), NOW, null), { due: true, maxItems: 13, postedLimit: 'week' })
  assertEquals(commentsPull(post(3, { comment_count: 2 }), NOW, null), { due: false, reason: 'no_new_comments' })
})

Deno.test('comments: 2–7 d once per 24 h', () => {
  assertEquals(commentsPull(post(72, { last_comments_pull_at: ago(10) }), NOW, null), { due: false, reason: 'pulled_within_24h' })
  assertEquals(commentsPull(post(72, { last_comments_pull_at: ago(25) }), NOW, null).due, true)
  assertEquals(commentsPull(post(72), NOW, null).due, true)
  assertEquals(commentsPull(post(72, { comment_count: 2, last_comments_pull_at: ago(30) }), NOW, null).due, false)
})

Deno.test('comments: > 7 d never; no backlog on the first run', () => {
  assertEquals(commentsPull(post(24 * 7 + 1), NOW, null), { due: false, reason: 'too_old' })
  // First run 3 days ago: a post that was already 8 days old then is never processed.
  const firstRun = ago(72)
  assertEquals(commentsPull(post(24 * 11), NOW, firstRun).due, false)
  assertEquals(commentsPull(post(24 * 5), NOW, firstRun).due, true)
})

Deno.test('comments input + reservation: maxItems = min(100, delta + 10)', () => {
  assertEquals(commentsPull(post(3, { comment_count: 500, comments_pulled_at_count: 0 }), NOW, null), { due: true, maxItems: 100, postedLimit: '24h' })
  assertEquals(commentsInput('https://www.linkedin.com/feed/update/urn:li:activity:1', { maxItems: 13, postedLimit: 'week' }), {
    posts: ['https://www.linkedin.com/feed/update/urn:li:activity:1'], maxItems: 13, postedLimit: 'week', scrapeReplies: true, profileScraperMode: 'short',
  })
  assertEquals(commentsReserveUsd(13), 0.04)
  assertEquals(commentsReserveUsd(100), 0.21)
})
