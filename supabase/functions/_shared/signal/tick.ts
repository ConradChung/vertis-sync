// GTM-14: one tick of the comments lane (signal-comments). Steps, in order,
// inside a ~120 s budget:
//   1 config + Apify cycle   2 caps (clear an expired stop)
//   3 collect finished Apify runs   4 posts (7 d / 48 h polls)
//   5 comments (+ 6 dedupe)   7 commenter filter stages
//   8 C's ingestReactorRuns, then reactor stages   9 summary
// Deps are injected so the whole tick runs against fakes in tests.
import { clip } from '../text.ts'
import { flattenPosts } from '../influencer/posts.ts'
import type { PplxAnswer } from '../influencer/verify.ts'
import type { JsonRequest } from '../influencer/haiku.ts'
import { actualUsd, type ApifyClient, failedUsd, type RunData, TERMINAL } from './apify.ts'
import { readCaps } from './caps.ts'
import { commentersToConsider, parseComments } from './comments.ts'
import { dedupeCommenters } from './dedupe.ts'
import type { Facts } from './drafts.ts'
import { type Counts, type CrawlResult, type EmailFinder, type FilterDeps, runCommenterStages, runReactorStages } from './filter.ts'
import { Gate } from './gate.ts'
import { readIcp } from './icp.ts'
import {
  COMMENTS_ACTOR,
  commentsInput,
  commentsPull,
  commentsReserveUsd,
  inWindow,
  ITEM_USD,
  POSTS_ACTOR,
  postsDue,
  postsInput,
  postsReserveUsd,
  WINDOW_MS,
} from './schedule.ts'
import type { Rest, SpendRow, Store } from './store.ts'

export const BUDGET_MS = 120_000
export const LEASE_SECONDS = 240
export const DEFAULT_PROFILE = 'https://www.linkedin.com/in/frank22/'
/** Don't start an Apify run with less than this left; waitForFinish gets what remains above it (≤ 60 s). */
const START_RESERVE_MS = 30_000

export interface TickDeps {
  store: Store
  apify: ApifyClient
  rest: Rest
  ingestReactorRuns: (rest: Rest, now: Date) => Promise<{ ingested: number }>
  haiku(req: JsonRequest): Promise<{ json: unknown; usd: number }>
  perplexity(question: string): Promise<PplxAnswer>
  crawl: ((domains: string[], deadlineS: number) => Promise<CrawlResult[]>) | null
  /** Blitz work-email lookup for the contacts stage (one session per tick). */
  email: EmailFinder & { recordsUsed?: number }
  facts: Facts
  /** wall clock (ms) */
  clock: () => number
  budgetMs?: number
  uuid?: () => string
}

export interface TickBody { force?: { posts_7d?: boolean; posts_48h?: boolean } }

export async function runTick(deps: TickDeps, body: TickBody = {}): Promise<Record<string, unknown>> {
  const startedAt = deps.clock()
  const now = () => new Date(deps.clock())
  const timeLeft = () => (deps.budgetMs ?? BUDGET_MS) - (deps.clock() - startedAt)
  const token = (deps.uuid ?? (() => crypto.randomUUID()))()
  const { store, apify } = deps

  if (!(await store.claimTick(token, LEASE_SECONDS))) return { ok: true, skipped: 'leased' }
  const counts: Counts = {}
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n)
  const errors: string[] = []
  try {
    // 1. Config.
    const settings = await store.settings()
    const cfg = (settings.signalConfig && typeof settings.signalConfig === 'object' ? settings.signalConfig : {}) as Record<string, unknown>
    const caps = readCaps(cfg.caps)
    const profileUrl = typeof cfg.profile_url === 'string' && cfg.profile_url ? cfg.profile_url : DEFAULT_PROFILE
    const reactorOpening = typeof cfg.reactor_opening === 'string' ? cfg.reactor_opening : null
    const usage = await apify.usage()
    let state = await store.state()
    if (!state.first_run_at) {
      await store.patchState({ first_run_at: now().toISOString() })
      state = { ...state, first_run_at: now().toISOString() }
    }

    // 2. Caps.
    const gate = new Gate(store, {
      caps, cycle: usage?.cycle ?? null, accountUsageUsd: usage?.usageUsd ?? null, accountCapUsd: settings.apifyCapUsd, state, now,
    })
    const stopCleared = await gate.clearExpiredStop()

    // 3. Collect finished runs.
    const finish = async (row: SpendRow, run: RunData) => {
      if (run.status === 'SUCCEEDED' || run.status === 'TIMED-OUT' || run.status === 'ABORTED') {
        const items = await apify.items(run.defaultDatasetId ?? row.dataset_id ?? '')
        if (row.kind === 'comments') await ingestComments(row.post_id, items)
        else await ingestPosts(items)
        await gate.settle(row.id, actualUsd(run, items.length, ITEM_USD))
        bump(`apify_${row.kind}_done`)
      } else {
        const usd = failedUsd(run)
        if (usd === null) await gate.release(row.id)
        else await gate.settle(row.id, usd)
        bump(`apify_${row.kind}_failed`)
      }
    }

    const ingestPosts = async (items: unknown[]) => {
      const rows = flattenPosts(items).filter((p) => inWindow(p.posted_at, now()))
      await store.upsertPosts(rows.map((p) => ({
        post_id: p.post_id, post_url: p.post_url, posted_at: new Date(p.posted_at!).toISOString(),
        likes: p.likes, comment_count: p.comments, text_excerpt: p.text ? clip(p.text, 500) : null,
      })))
      bump('posts_seen', rows.length)
    }

    const ingestComments = async (postId: string | null, items: unknown[]) => {
      if (!postId) return
      const post = (await store.recentPosts(new Date(now().getTime() - WINDOW_MS - 86_400_000).toISOString())).find((p) => p.post_id === postId)
      const people = commentersToConsider(parseComments(items), { profileUrl })
      const d = await dedupeCommenters(store, people, postId)
      bump('commenters_new', d.new)
      bump('commenters_skipped_known', d.skipped)
      bump('commenters_existing', d.existing)
      bump('reactors_upgraded', d.upgraded)
      if (post) await store.patchPost(postId, { comments_pulled_at_count: post.comment_count, last_comments_pull_at: now().toISOString() })
    }

    for (const row of await store.reservedApifyRuns()) {
      if (timeLeft() < 20_000) break
      try {
        const run = await apify.run(row.apify_run_id!)
        if (TERMINAL.has(run.status ?? '')) await finish(row, run)
      } catch (err) {
        errors.push(`collect ${row.apify_run_id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    /** Reserve, start (waitForFinish), record the run; process it at once if it finished in time. */
    const startRun = async (kind: string, actor: string, input: Record<string, unknown>, usd: number, postId: string | null): Promise<'started' | 'refused' | 'failed'> => {
      const id = await gate.reserve(kind, usd, postId)
      if (id === null) return 'refused'
      const wait = Math.min(60, Math.floor((timeLeft() - START_RESERVE_MS) / 1000))
      const res = await apify.start(actor, input, usd, wait)
      if (!res.ok) {
        // An unknown outcome may have started a paid run: keep the reservation as its cost.
        if (res.unknown) await gate.settle(id, usd)
        else await gate.release(id)
        errors.push(`${kind} start: ${res.error}`)
        return 'failed'
      }
      await store.patchSpend(id, { apify_run_id: res.run.id ?? null, dataset_id: res.run.defaultDatasetId ?? null })
      bump(`apify_${kind}_started`)
      if (TERMINAL.has(res.run.status ?? '')) {
        await finish({ id, lane: 'comments_apify', kind, status: 'reserved', usd, apify_run_id: res.run.id ?? null, dataset_id: res.run.defaultDatasetId ?? null, post_id: postId, person_id: null, created_at: now().toISOString() }, res.run)
      }
      return 'started'
    }

    // 4. Posts.
    for (const kind of postsDue(state, now(), body.force ?? {})) {
      if (!gate.canSpend || timeLeft() < START_RESERVE_MS + 10_000) break
      await store.patchState(kind === 'posts_7d' ? { last_posts_7d_at: now().toISOString() } : { last_posts_48h_at: now().toISOString() })
      const r = await startRun(kind, POSTS_ACTOR, postsInput(profileUrl, kind, now()), postsReserveUsd(), null)
      if (r === 'refused') break
    }

    // 5. Comments (dedupe runs as each run's items are ingested).
    const open = new Set((await store.reservedApifyRuns()).filter((r) => r.kind === 'comments').map((r) => r.post_id))
    for (const post of await store.recentPosts(new Date(now().getTime() - WINDOW_MS).toISOString())) {
      if (!gate.canSpend || timeLeft() < START_RESERVE_MS + 10_000) break
      if (open.has(post.post_id)) continue
      const d = commentsPull(post, now(), state.first_run_at)
      if (!d.due) continue
      const r = await startRun('comments', COMMENTS_ACTOR, commentsInput(post.post_url, d), commentsReserveUsd(d.maxItems), post.post_id)
      if (r === 'refused') break
    }

    // 7. Commenter filter stages.
    const fd: FilterDeps = {
      store, gate, now, timeLeft, haiku: deps.haiku, perplexity: deps.perplexity, crawl: deps.crawl, email: deps.email,
      facts: deps.facts, reactorOpening, icp: readIcp(cfg.icp),
    }
    try {
      await runCommenterStages(fd, counts)
    } catch (err) {
      errors.push(`commenter stages: ${err instanceof Error ? err.message : String(err)}`)
    }

    // 8. Reactors (C's ingest, then crawl → doors → contacts → draft).
    try {
      const r = await deps.ingestReactorRuns(deps.rest, now())
      bump('reactors_ingested', r.ingested)
    } catch (err) {
      errors.push(`ingestReactorRuns: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      await runReactorStages(fd, counts)
    } catch (err) {
      errors.push(`reactor stages: ${err instanceof Error ? err.message : String(err)}`)
    }

    // 9. Summary.
    return {
      ok: true,
      counts,
      spend: { reserved_usd: gate.reservedUsd, settled_usd: gate.settledUsd },
      notices: gate.notices,
      stopped: gate.stopped ? gate.reason : null,
      stop_cleared: stopCleared,
      email_records_used: deps.email.recordsUsed ?? 0,
      cycle: usage?.cycle ?? null,
      errors,
      ms: deps.clock() - startedAt,
    }
  } finally {
    await store.releaseTick(token).catch(() => undefined)
  }
}
