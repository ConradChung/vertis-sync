import 'server-only'
import { listChannels, slackApi } from '@/lib/slack/api'
import type { Block } from '@/lib/slack/card'
import { isSlackConfigured } from '@/lib/slack/config'
import { buildSignalCard, buildSignalDigest } from '@/lib/slack/signalCard'
import { getBotToken, listInstalls } from '@/lib/slack/store'
import { signalCardOpts, type SignalConfig } from '@/lib/signal/config'
import {
  claimDigest,
  claimNotice,
  claimPerson,
  getSignalConfig,
  listPendingNotices,
  listReadyCommenters,
  listReadyDigests,
  listReadyReactors,
  markDigestPosted,
  markPersonPosted,
  markReactors,
  releaseDigest,
  releaseNotice,
  releasePerson,
  saveDryRunCard,
  saveSignalSlack,
  getSignalPost,
} from '@/lib/signal/store'

/**
 * GTM-14: post what the signal-comments edge fn marked ready to #sales
 * (POST /api/cron/signal-alerts, X-Lume-Hook-Secret).
 *
 *  - Dry run (signal_config.dry_run, the default): the card is built and
 *    saved, alert_status 'dry_run'; no Slack call at all (not even the
 *    channel lookup). Dry-run rows are never posted later.
 *  - Live: claim (alert_status null → 'posted') BEFORE chat.postMessage, then
 *    save ts / team / channel and stage 'alerted'. A failed send releases the
 *    claim. A retry or a concurrent tick finds the row claimed and skips it,
 *    so nothing posts twice.
 *  - Nothing here sends to a lead: the cards carry drafts to copy by hand.
 */

export interface SignalAlertsSummary {
  ok: boolean
  dry_run: boolean
  channel: { team_id: string; channel_id: string } | null
  commenters: { posted: number; dry_run: number; skipped: number; failed: number; refused: number }
  digests: { posted: number; dry_run: number; empty: number; skipped: number; failed: number }
  notices: { posted: number; dry_run: number; skipped: number; failed: number }
  errors: string[]
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

type Target = { team: string; channel: string; token: string }

/** The #sales channel and bot token (config first, else find it by name and save it back). */
export async function resolveChannel(cfg: SignalConfig): Promise<Target | { error: string }> {
  if (!isSlackConfigured()) return { error: 'slack_not_configured' }
  let team = cfg.slack.team_id
  if (!team) {
    const live = (await listInstalls()).filter((i) => !i.revoked_at)
    if (live.length !== 1) return { error: live.length ? 'several_slack_installs_set_signal_config_team_id' : 'no_slack_install' }
    team = live[0].team_id
  }
  const bot = await getBotToken(team)
  if (!bot) return { error: 'slack_install_missing_or_revoked' }
  if (cfg.slack.team_id === team && cfg.slack.channel_id) return { team, channel: cfg.slack.channel_id, token: bot.token }
  const name = cfg.slack.channel_name
  const ch = (await listChannels(bot.token)).find((c) => c.name === name)
  if (!ch) return { error: `channel_not_found:#${name}` }
  if (!ch.is_member) return { error: `bot_not_in_channel:#${name}` }
  await saveSignalSlack(cfg, team, ch.id)
  return { team, channel: ch.id, token: bot.token }
}

async function post(t: Target, text: string, blocks?: unknown[]): Promise<string> {
  const res = await slackApi('chat.postMessage', t.token, { channel: t.channel, text, ...(blocks ? { blocks } : {}), unfurl_links: false, unfurl_media: false })
  const ts = typeof res.ts === 'string' ? res.ts : null
  if (!ts) throw new Error('chat.postMessage returned no ts')
  return ts
}

export async function runSignalAlerts(now: Date = new Date()): Promise<SignalAlertsSummary> {
  const cfg = await getSignalConfig()
  const out: SignalAlertsSummary = {
    ok: true,
    dry_run: cfg.dry_run,
    channel: null,
    commenters: { posted: 0, dry_run: 0, skipped: 0, failed: 0, refused: 0 },
    digests: { posted: 0, dry_run: 0, empty: 0, skipped: 0, failed: 0 },
    notices: { posted: 0, dry_run: 0, skipped: 0, failed: 0 },
    errors: [],
  }
  const opts = signalCardOpts(now)

  const [commenters, digests, notices] = await Promise.all([listReadyCommenters(), listReadyDigests(), listPendingNotices()])
  if (!commenters.length && !digests.length && !notices.length) return out

  let target: Target | null = null
  if (!cfg.dry_run) {
    const r = await resolveChannel(cfg)
    if ('error' in r) {
      out.ok = false
      out.errors.push(r.error)
      return out
    }
    target = r
    out.channel = { team_id: r.team, channel_id: r.channel }
  }

  // ── commenters ──
  for (const row of commenters) {
    let card: { text: string; blocks: Block[] }
    try {
      card = buildSignalCard(row, { ...opts, post: row.post_id ? await getSignalPost(row.post_id) : null })
    } catch (err) {
      out.commenters.refused++
      out.errors.push(`person ${row.id}: ${msg(err)}`)
      continue
    }
    const blocks = card.blocks
    if (!target) {
      if (await saveDryRunCard(row.id, blocks)) out.commenters.dry_run++
      else out.commenters.skipped++
      continue
    }
    if (!(await claimPerson(row.id, blocks))) {
      out.commenters.skipped++
      continue
    }
    let ts: string
    try {
      ts = await post(target, card.text, card.blocks)
    } catch (err) {
      out.commenters.failed++
      out.errors.push(`person ${row.id}: ${msg(err)}`)
      await releasePerson(row.id).catch((e) => out.errors.push(`person ${row.id} release: ${msg(e)}`))
      continue
    }
    out.commenters.posted++
    await markPersonPosted(row.id, { team: target.team, channel: target.channel, ts }).catch((e) => out.errors.push(`person ${row.id} save ts: ${msg(e)}`))
  }

  // ── reactor digests (one per post) ──
  for (const p of digests) {
    const reactors = await listReadyReactors(p.post_id)
    const digest = buildSignalDigest(p, reactors, { ...opts, reactorOpening: cfg.reactor_opening })
    if (!digest.shown.length) {
      if (await claimDigest(p.post_id, 'empty', null)) out.digests.empty++
      else out.digests.skipped++
      continue
    }
    const blocks = digest.blocks
    if (!target) {
      if (await claimDigest(p.post_id, 'dry_run', blocks)) {
        out.digests.dry_run++
        await markReactors(digest.shown, 'dry_run')
      } else out.digests.skipped++
      continue
    }
    if (!(await claimDigest(p.post_id, 'posted', blocks))) {
      out.digests.skipped++
      continue
    }
    let ts: string
    try {
      ts = await post(target, digest.text, digest.blocks)
    } catch (err) {
      out.digests.failed++
      out.errors.push(`digest ${p.post_id}: ${msg(err)}`)
      await releaseDigest(p.post_id).catch((e) => out.errors.push(`digest ${p.post_id} release: ${msg(e)}`))
      continue
    }
    out.digests.posted++
    await markDigestPosted(p.post_id, ts).catch((e) => out.errors.push(`digest ${p.post_id} save ts: ${msg(e)}`))
    await markReactors(digest.shown, 'posted', { team: target.team, channel: target.channel, ts }).catch((e) => out.errors.push(`digest ${p.post_id} reactors: ${msg(e)}`))
  }

  // ── notices (cap warnings, lane stops) ──
  for (const n of notices) {
    if (!target) {
      if (await claimNotice(n.key, 'dry_run')) out.notices.dry_run++
      else out.notices.skipped++
      continue
    }
    if (!(await claimNotice(n.key, 'posted'))) {
      out.notices.skipped++
      continue
    }
    try {
      // Notice text is ours (the edge fn's), still escaped: plain text only.
      await post(target, n.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 3000))
      out.notices.posted++
    } catch (err) {
      out.notices.failed++
      out.errors.push(`notice ${n.key}: ${msg(err)}`)
      await releaseNotice(n.key).catch((e) => out.errors.push(`notice ${n.key} release: ${msg(e)}`))
    }
  }

  if (out.commenters.failed || out.digests.failed || out.notices.failed) out.ok = false
  return out
}
