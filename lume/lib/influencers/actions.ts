import 'server-only'
import { z } from 'zod'
import type { Json } from '@/lib/db/types'
import { callInfluencerFn } from '@/lib/adapters/influencerFn'
import { estimateRun, reactionsMaxChargeUsd } from '@/lib/influencers/model'
import { MaxVerifyUsd, Slug } from '@/lib/influencers/schemas'
import { activeRun, getInfluencersByIds, getInfluencersBySlugs, getRun } from '@/lib/influencers/store'
import { INFLUENCER_PIPELINE, type InfluencerActionBuild } from '@/lib/influencers/actionPayload'

/**
 * The two approvals of the PM influencer reactions pipeline (server-side
 * builders and executors; `lib/actions/build.ts` and `lib/actions/execute.ts`
 * dispatch here).
 *
 *  influencer_run        { slugs, max_verify_usd? } → the posts scrape + Haiku
 *                        top-posts ranking, priced from each influencer's last
 *                        run; the run stops after top posts.
 *  influencer_reactions  { run_id, max_verify_usd? } → the EXACT reactions bill
 *                        the run computed at top posts, then triage and
 *                        Perplexity verify under max_verify_usd.
 *
 * Both executors re-check the snapshot against live data before calling the
 * edge function: the same active influencers and no other active run; the run
 * still awaiting with the same bill.
 */

const fmt = (n: number) => `$${n.toFixed(2)}`
const fail = (status: number, error: string): InfluencerActionBuild => ({ ok: false, status, error })

const RunBody = z.object({ slugs: z.array(Slug).min(1).max(100), max_verify_usd: MaxVerifyUsd.optional() })
const ReactionsBody = z.object({ run_id: z.string().uuid(), max_verify_usd: MaxVerifyUsd.optional() })

export async function buildInfluencerRun(raw: Record<string, unknown>): Promise<InfluencerActionBuild> {
  const body = RunBody.safeParse(raw)
  if (!body.success) return fail(400, 'invalid_payload')
  const slugs = [...new Set(body.data.slugs)]
  const rows = await getInfluencersBySlugs(slugs)
  const unknown = slugs.filter((s) => !rows.some((r) => r.slug === s))
  if (unknown.length) return fail(404, `unknown_influencers: ${unknown.join(', ')}`)
  const inactive = rows.filter((r) => !r.active).map((r) => r.slug)
  if (inactive.length) return fail(409, `inactive_influencers: ${inactive.join(', ')}`)
  if (await activeRun()) return fail(409, 'run_in_progress')
  const maxVerify = body.data.max_verify_usd ?? 10
  const ordered = slugs.map((s) => rows.find((r) => r.slug === s)!)
  const est = estimateRun(ordered, { maxVerifyUsd: maxVerify })
  const names = ordered.map((r) => r.name)
  const who = names.length > 4 ? `${names.slice(0, 4).join(', ')} +${names.length - 4} more` : names.join(', ')
  const summary =
    `PM influencer reactions run for ${names.length} influencer${names.length === 1 ? '' : 's'} (${who}). ` +
    `Approving runs the posts scrape now: ~${fmt(est.posts_usd_now)} (Apify charge capped at ${fmt(est.posts_reserve_usd)}) + Haiku top-posts ranking (~${fmt(est.haiku_top_posts_usd)}). ` +
    `It stops after top posts with the exact reactions bill (expected ${fmt(est.reactions_usd.low)}-${fmt(est.reactions_usd.high)}) for a second approval; ` +
    `Perplexity verify later is capped at ${fmt(maxVerify)} (expected ${fmt(est.perplexity_usd.low)}-${fmt(est.perplexity_usd.high)}).`
  return {
    ok: true,
    kind: 'influencer_run',
    payload: {
      pipeline: INFLUENCER_PIPELINE,
      influencer_ids: ordered.map((r) => r.id),
      slugs: ordered.map((r) => r.slug),
      names,
      max_verify_usd: maxVerify,
      posts_usd: est.posts_usd_now,
      posts_reserve_usd: est.posts_reserve_usd,
      reactions_usd_range: est.reactions_usd as unknown as Json,
      perplexity_usd_range: est.perplexity_usd as unknown as Json,
      total_usd_range: est.total_usd as unknown as Json,
      expected_leads: est.leads as unknown as Json,
      warnings: est.warnings,
      summary,
    },
  }
}

export async function buildInfluencerReactions(raw: Record<string, unknown>): Promise<InfluencerActionBuild> {
  const body = ReactionsBody.safeParse(raw)
  if (!body.success) return fail(400, 'invalid_payload')
  const runId = body.data.run_id.toLowerCase()
  const run = await getRun(runId)
  if (!run) return fail(404, 'run_not_found')
  if (run.status !== 'awaiting_approval' || run.stage !== 'reactions' || run.reactions_estimate_usd === null) {
    return fail(409, `run_not_awaiting_reactions (status ${run.status}, stage ${run.stage})`)
  }
  const per = (run.reactions_estimate ?? []).filter((e) => e.reactions > 0)
  const reactions = per.reduce((s, e) => s + e.reactions, 0)
  const usd = Number(run.reactions_estimate_usd)
  const maxCharge = Math.round(per.reduce((s, e) => s + reactionsMaxChargeUsd(e.usd), 0) * 100) / 100
  const maxVerify = body.data.max_verify_usd ?? Number(run.max_verify_usd)
  const lines = per.map((e) => `${e.name} ${e.reactions} (${fmt(e.usd)})`)
  const summary =
    `Approve the reactions scrape for PM influencer run ${runId.slice(0, 8)}: exactly ${reactions.toLocaleString('en-US')} reactions on ` +
    `${per.reduce((s, e) => s + e.posts, 0)} top posts = ${fmt(usd)} (Apify charge capped at ${fmt(maxCharge)}), ` +
    `then Haiku triage of the new reactors and Perplexity verify capped at ${fmt(maxVerify)}. ` +
    `Per influencer: ${lines.join('; ')}.`
  return {
    ok: true,
    kind: 'influencer_reactions',
    payload: {
      run_id: runId,
      reactions,
      reactions_usd: usd,
      max_charge_usd: maxCharge,
      max_verify_usd: maxVerify,
      per_influencer: per.map((e) => ({ name: e.name, slug: e.slug, posts: e.posts, reactions: e.reactions, usd: e.usd })),
      summary,
    },
  }
}

export type ExecOutcome = { ok: true; result: Record<string, Json> } | { ok: false; error: string; result: Record<string, Json> }

export async function executeInfluencerRun(p: Record<string, Json>, actionId: string): Promise<ExecOutcome> {
  const ids = Array.isArray(p.influencer_ids) ? p.influencer_ids.filter((x): x is string => typeof x === 'string') : []
  if (!ids.length) return { ok: false, error: 'payload.influencer_ids is missing', result: {} }
  const live = await getInfluencersByIds(ids)
  const gone = ids.filter((id) => !live.some((r) => r.id === id && r.active))
  if (gone.length) return { ok: false, error: 'an influencer was removed or deactivated since approval', result: { influencer_ids: gone } }
  const active = await activeRun()
  if (active && active.start_action_id !== actionId) {
    return { ok: false, error: 'another influencer run is active', result: { run_id: active.id, status: active.status } }
  }
  const estimate: Record<string, Json> = {
    posts_usd: p.posts_usd ?? null,
    posts_reserve_usd: p.posts_reserve_usd ?? null,
    reactions_usd_range: p.reactions_usd_range ?? null,
    perplexity_usd_range: p.perplexity_usd_range ?? null,
    total_usd_range: p.total_usd_range ?? null,
  }
  const r = await callInfluencerFn({ action: 'start', influencer_ids: ids, max_verify_usd: p.max_verify_usd, start_action_id: actionId, estimate })
  if (!r.ok) return { ok: false, error: `influencer-reactions start: ${r.error}`, result: { http_status: r.status } }
  return { ok: true, result: { run_id: String(r.body.run_id ?? ''), status: String(r.body.status ?? 'running'), stage: 'posts' } }
}

export async function executeInfluencerReactions(p: Record<string, Json>, actionId: string): Promise<ExecOutcome> {
  const runId = typeof p.run_id === 'string' ? p.run_id : ''
  const usd = typeof p.reactions_usd === 'number' ? p.reactions_usd : NaN
  if (!runId || !Number.isFinite(usd)) return { ok: false, error: 'payload.run_id / reactions_usd missing', result: {} }
  const run = await getRun(runId)
  if (!run || run.status !== 'awaiting_approval' || run.stage !== 'reactions') {
    return { ok: false, error: 'the run is no longer waiting for this approval', result: { run_id: runId, status: run?.status ?? null } }
  }
  if (Math.abs(Number(run.reactions_estimate_usd) - usd) > 1e-6) {
    return { ok: false, error: 'the reactions bill changed since approval', result: { run_id: runId, approved_usd: usd, current_usd: Number(run.reactions_estimate_usd) } }
  }
  const r = await callInfluencerFn({ action: 'approve_reactions', run_id: runId, approved_usd: usd, reactions_action_id: actionId, max_verify_usd: p.max_verify_usd })
  if (!r.ok) return { ok: false, error: `influencer-reactions approve: ${r.error}`, result: { run_id: runId, http_status: r.status } }
  return { ok: true, result: { run_id: runId, status: 'running', stage: 'reactions', approved_usd: usd } }
}
