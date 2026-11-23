import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => { throw new Error('no db in tests') } }))
vi.mock('@/lib/actions/build', () => ({ buildActionRequest: vi.fn() }))
vi.mock('@/lib/actions/create', () => ({ createAction: vi.fn(), DuplicateActionError: class extends Error {} }))
vi.mock('@/lib/settings/store', () => ({ getApifyCapUsd: async () => 29 }))

import {
  dueWindow,
  estimateReactionsUsd,
  parseApifyUsage,
  parseSignalConfig,
  postUrlFor,
  runSignalReactions,
  type ReactionsDeps,
  type SignalPost,
} from '@/lib/signal/reactions'

// 2026-11-23 is a Monday; PST is UTC-8.
const MON_0759 = new Date('2026-11-23T15:59:00Z')
const MON_0800 = new Date('2026-11-23T16:00:00Z')
const TUE_0900 = new Date('2026-11-24T17:00:00Z')

const usageBody = (used: number) => ({
  data: {
    usageCycle: { startAt: '2026-11-15T00:00:00.000Z', endAt: '2026-12-14T23:59:59.999Z' },
    totalUsageCreditsUsdAfterVolumeDiscount: used,
  },
})

type Row = SignalPost & { reactions_status: string; reactions_note?: string; reactions_action_id?: string }

function fakeDeps(o: { posts: Row[]; used?: number; laneSpent?: number; dryRun?: boolean }) {
  const posts = o.posts
  const calls = { file: [] as string[][], reserve: [] as { post_id: string; usd: number }[][], notices: [] as { key: string; text: string }[] }
  const deps: ReactionsDeps = {
    loadConfig: async () => parseSignalConfig({ dry_run: o.dryRun ?? false, caps: { reactions_apify_usd: 8, reactions_per_post: 200 } }),
    candidatePosts: async (from, to) =>
      posts.filter((p) =>
        (p.reactions_status === 'pending' && Date.parse(p.posted_at) >= from.getTime() && Date.parse(p.posted_at) < to.getTime()) ||
        p.reactions_status === 'held') as SignalPost[],
    apifyUsage: async () => parseApifyUsage(usageBody(o.used ?? 3)),
    laneSpend: async () => o.laneSpent ?? 0,
    accountCapUsd: async () => 29,
    patchPosts: async (ids, patch) => {
      for (const p of posts) if (ids.includes(p.post_id) && ['pending', 'held'].includes(p.reactions_status)) Object.assign(p, patch)
    },
    addNotice: async (key, text) => {
      if (!calls.notices.some((n) => n.key === key)) calls.notices.push({ key, text })
    },
    fileCard: async (_url, _cap, urls) => {
      calls.file.push(urls)
      return { ok: true, actionId: '44444444-4444-4444-8444-444444444444' }
    },
    reserve: async (rows) => {
      calls.reserve.push(rows)
    },
  }
  return { deps, calls, posts }
}

const post = (id: string, posted_at: string, likes: number | null, status = 'pending'): Row =>
  ({ post_id: id, post_url: `https://www.linkedin.com/posts/frank22_x-activity-${id}-abc`, posted_at, likes, reactions_status: status }) as Row

describe('dueWindow', () => {
  it('is due on Monday from 08:00 PT, for the previous Mon 00:00 – Sun 23:59 PT week', () => {
    expect(dueWindow(MON_0759, false)).toEqual({ due: false })
    expect(dueWindow(TUE_0900, false)).toEqual({ due: false })
    const w = dueWindow(MON_0800, false)
    if (!w.due) throw new Error('not due')
    expect(w.mode).toBe('scheduled')
    expect(w.from.toISOString()).toBe('2026-11-16T08:00:00.000Z')
    expect(w.to.toISOString()).toBe('2026-11-23T08:00:00.000Z')
  })
  it('forced: the last 7 days, any day', () => {
    const w = dueWindow(TUE_0900, true)
    if (!w.due) throw new Error('not due')
    expect([w.mode, w.from.toISOString(), w.to.toISOString()]).toEqual(['forced', '2026-11-17T17:00:00.000Z', '2026-11-24T17:00:00.000Z'])
  })
})

describe('estimate', () => {
  it('Σ min(likes, per-post cap) × $2/1k; unknown likes count as the cap', () => {
    expect(estimateReactionsUsd([{ likes: 50 }, { likes: 900 }, { likes: null }], 200)).toBe(0.9) // 50 + 200 + 200 = 450
    expect(estimateReactionsUsd([], 200)).toBe(0)
  })
})

describe('parseApifyUsage', () => {
  it('reads usage and the cycle bounds; null without usageCycle', () => {
    expect(parseApifyUsage(usageBody(3))).toEqual({ usedUsd: 3, cycleStart: '2026-11-15T00:00:00.000Z', cycleEnd: '2026-12-14T23:59:59.999Z' })
    expect(parseApifyUsage({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 3 } })).toBeNull()
  })
})

describe('runSignalReactions', () => {
  it('not due: touches nothing', async () => {
    const f = fakeDeps({ posts: [post('1', '2026-11-18T18:00:00Z', 10)] })
    expect(await runSignalReactions(MON_0759, {}, f.deps)).toEqual({ ok: true, outcome: 'not_due' })
    expect(f.posts[0].reactions_status).toBe('pending')
  })

  it('files last week\'s posts on one card, reserves the estimate, and never re-files them', async () => {
    const f = fakeDeps({ posts: [post('1', '2026-11-18T18:00:00Z', 50), post('2', '2026-11-20T18:00:00Z', 900), post('3', '2026-11-10T18:00:00Z', 10)] })
    const r = await runSignalReactions(MON_0800, {}, f.deps)
    expect(r).toMatchObject({ ok: true, outcome: 'filed', posts: ['1', '2'], estimate_usd: 0.5 })
    expect(f.calls.file).toEqual([[postUrlFor('1'), postUrlFor('2')]])
    expect(f.calls.reserve).toEqual([[{ post_id: '1', usd: 0.1 }, { post_id: '2', usd: 0.4 }]])
    expect(f.posts.map((p) => p.reactions_status)).toEqual(['filed', 'filed', 'pending'])
    expect(f.posts[0].reactions_action_id).toBe('44444444-4444-4444-8444-444444444444')

    const again = await runSignalReactions(new Date('2026-11-23T17:00:00Z'), {}, f.deps)
    expect(again).toEqual({ ok: true, outcome: 'nothing_to_file' })
    expect(f.calls.file).toHaveLength(1)
  })

  it('holds when the lane cap does not fit, with the reset date from usageCycle, one notice per cycle', async () => {
    const f = fakeDeps({ posts: [post('1', '2026-11-18T18:00:00Z', 900)], laneSpent: 7.8 })
    const r = await runSignalReactions(MON_0800, {}, f.deps)
    expect(r).toEqual({ ok: true, outcome: 'held', posts: ['1'], note: 'held: needs $0.40, $0.20 left; Apify cycle resets 2026-12-14' })
    expect(f.posts[0]).toMatchObject({ reactions_status: 'held', reactions_note: 'held: needs $0.40, $0.20 left; Apify cycle resets 2026-12-14' })
    expect(f.calls.file).toHaveLength(0)
    await runSignalReactions(new Date('2026-11-23T17:00:00Z'), {}, f.deps)
    expect(f.calls.notices.map((n) => n.key)).toEqual(['hold:reactions:2026-11-15T00:00:00.000Z'])
  })

  it('holds on the account cap too, and a held post is filed once it fits again', async () => {
    const f = fakeDeps({ posts: [post('1', '2026-11-18T18:00:00Z', 900)], used: 28.9 })
    expect(await runSignalReactions(MON_0800, {}, f.deps)).toMatchObject({ outcome: 'held', note: 'held: needs $0.40, $0.10 left; Apify cycle resets 2026-12-14' })
    const later = fakeDeps({ posts: f.posts, used: 1 })
    // a later week: the held post is outside the window but still retried
    expect(await runSignalReactions(new Date('2026-12-21T16:30:00Z'), {}, later.deps)).toMatchObject({ outcome: 'filed', posts: ['1'] })
  })

  it('dry run files nothing and returns the card preview', async () => {
    const f = fakeDeps({ posts: [post('1', '2026-11-18T18:00:00Z', 50), post('2', '2026-11-20T18:00:00Z', null)], dryRun: true })
    const r = await runSignalReactions(MON_0800, {}, f.deps)
    if (!r.ok || r.outcome !== 'dry_run') throw new Error(JSON.stringify(r))
    expect(r.note).toBe('dry_run: would file 2 posts, est $0.50, per-post cap 200')
    expect(r.preview.title).toMatch(/2 posts/)
    expect(r.preview.posts.map((p) => p.post_url)).toEqual([postUrlFor('1'), postUrlFor('2')])
    expect(r.preview.bill).toMatchObject({ estimate_usd: 0.5, reactions_max: 400, card_usd: 0.8, per_post_cap: 200 })
    expect(f.calls.file).toHaveLength(0)
    expect(f.calls.reserve).toHaveLength(0)
    expect(f.posts.map((p) => p.reactions_status)).toEqual(['pending', 'pending'])
    expect(f.posts[0].reactions_note).toBe(r.note)
  })

  it('forced: the last 7 days', async () => {
    const f = fakeDeps({ posts: [post('1', '2026-11-22T18:00:00Z', 10), post('2', '2026-11-12T18:00:00Z', 10)] })
    expect(await runSignalReactions(TUE_0900, { force: true }, f.deps)).toMatchObject({ outcome: 'filed', posts: ['1'] })
  })
})
