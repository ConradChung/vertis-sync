import 'server-only'
import { slackApi } from '@/lib/slack/api'
import { resolveChannel } from '@/lib/signal/alerts'
import { getSignalConfig } from '@/lib/signal/store'
import { buildRedditCard } from '@/lib/reddit/card'
import { authorFromContext, clip, extractF5Excerpts, extractRedditLinks, findKeyword, isHot, parseRedditJson, type RedditLink, type RedditThing } from '@/lib/reddit/parse'
import { summarizeExcerpt, type Summarize } from '@/lib/reddit/summary'
import {
  claimMention,
  existingKeys,
  fillMentionText,
  insertMention,
  listEmails,
  listUnalerted,
  markMentionPosted,
  mentionsMissingSnippet,
  releaseMention,
  saveEmail,
} from '@/lib/reddit/store'

/**
 * GTM-15: one F5Bot alert email (forwarded by the Apps Script in the inbox
 * that receives them) → stored mentions → #sales cards.
 *
 *  - Dedupe on the canonical permalink: the same email twice, or two emails
 *    with the same link, make one row and one card.
 *  - Reddit's public JSON gives the handle when it answers (it 403s most
 *    servers); otherwise the handle comes from F5Bot's own text when it names
 *    one, and the row is stored either way (fetch_error) with F5Bot's
 *    snippet. No handle → the card says "unknown handle, open the thread".
 *  - Posting is off until `signal_config.reddit_live` is exactly true: until
 *    then each card is built and saved as alert_status 'dry_run' and nothing
 *    reaches Slack. Live: claim before chat.postMessage, release on failure,
 *    so nothing posts twice. Rows a failed send left unalerted are retried by
 *    the next email.
 *  - The comment itself comes from F5Bot's HTML part (`f5-excerpt` per hit),
 *    with a one-line Haiku summary of it. No HTML / no excerpt → title-only
 *    card, as before. Reddit's JSON is only tried when there is no excerpt.
 *  - Nothing is sent to anyone on Reddit; the card's DM link is for a person.
 */

export interface F5botEmail {
  message_id?: string | null
  subject?: string | null
  body?: string | null
  html?: string | null
}

export interface IngestSummary {
  ok: boolean
  live: boolean
  links: number
  inserted: number
  duplicate: number
  unreadable: number
  posted: number
  dry_run: number
  failed: number
  errors: string[]
}

export const REDDIT_TIMEOUT_MS = 6_000
const UA = 'lume-signals/1.0'
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

export type RedditFetch = (link: RedditLink) => Promise<RedditThing | null>

/** `<link>.json` from Reddit, null on any failure (rate limit, 403, removed). */
export const fetchRedditThing: RedditFetch = async (link) => {
  const res = await fetch(`${link.url.replace(/\/$/, '')}.json?raw_json=1&limit=1`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(REDDIT_TIMEOUT_MS),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`reddit ${res.status}`)
  return parseRedditJson(await res.json(), link)
}

export async function ingestF5bot(
  email: F5botEmail,
  fetchThing: RedditFetch = fetchRedditThing,
  now: Date = new Date(),
  summarize: Summarize = summarizeExcerpt
): Promise<IngestSummary> {
  const cfg = await getSignalConfig()
  const live = cfg.raw.reddit_live === true
  const out: IngestSummary = { ok: true, live, links: 0, inserted: 0, duplicate: 0, unreadable: 0, posted: 0, dry_run: 0, failed: 0, errors: [] }

  if (email.message_id) {
    // Never blocks the alert: a failed save is only reported.
    await saveEmail({ message_id: email.message_id, subject: email.subject ?? null, body: email.body ?? null, html: email.html ?? null }).catch((e) => out.errors.push(`save email: ${msg(e)}`))
  }

  const links = extractRedditLinks(email.body ?? '', email.html ?? '')
  const excerpts = extractF5Excerpts(email.html)
  out.links = links.length
  const known = await existingKeys(links.map((l) => l.key))

  for (const link of links) {
    if (known.has(link.key)) {
      out.duplicate++
      continue
    }
    const excerpt = excerpts.get(link.key) ?? null
    let thing: RedditThing | null = null
    let fetchError: string | null = null
    if (!excerpt) {
      try {
        thing = await fetchThing(link)
        if (!thing) fetchError = 'not_found'
      } catch (err) {
        fetchError = msg(err)
      }
      if (fetchError) out.unreadable++
    }
    const title = clip(thing?.title ?? link.f5Title, 300)
    const text = thing?.text ?? excerpt
    const keyword = findKeyword(title, text) ?? findKeyword(link.context, email.subject)
    const summary = text ? await summarize({ title, excerpt: text, keyword }) : null
    const inserted = await insertMention({
      permalink: link.key,
      url: link.url,
      kind: link.kind,
      subreddit: thing?.subreddit ?? link.subreddit,
      author: thing?.author ?? link.f5Author ?? authorFromContext(link.context),
      title,
      snippet: clip(text),
      summary,
      keyword,
      hot: isHot(title, text),
      reddit_created_at: thing?.createdAt ?? null,
      fetch_error: fetchError,
      email_message_id: email.message_id ?? null,
    })
    if (inserted) out.inserted++
    else out.duplicate++
  }

  // Post (or save as dry run) everything not alerted yet, including earlier failures.
  const pending = await listUnalerted()
  if (!pending.length) return out

  let target: { team: string; channel: string; token: string } | null = null
  if (live) {
    const r = await resolveChannel(cfg)
    if ('error' in r) {
      out.ok = false
      out.errors.push(r.error)
      return out
    }
    target = r
  }

  for (const row of pending) {
    const card = buildRedditCard(row, now)
    if (!target) {
      if (await claimMention(row.id, 'dry_run', card.blocks)) out.dry_run++
      continue
    }
    if (!(await claimMention(row.id, 'posted', card.blocks))) continue
    try {
      const res = await slackApi('chat.postMessage', target.token, { channel: target.channel, text: card.text, blocks: card.blocks, unfurl_links: false, unfurl_media: false })
      const ts = typeof res.ts === 'string' ? res.ts : null
      if (!ts) throw new Error('chat.postMessage returned no ts')
      out.posted++
      await markMentionPosted(row.id, { team: target.team, channel: target.channel, ts }).catch((e) => out.errors.push(`mention ${row.id} save ts: ${msg(e)}`))
    } catch (err) {
      out.failed++
      out.errors.push(`mention ${row.id}: ${msg(err)}`)
      await releaseMention(row.id).catch((e) => out.errors.push(`mention ${row.id} release: ${msg(e)}`))
    }
  }
  if (out.failed) out.ok = false
  return out
}

export interface BackfillSummary {
  ok: boolean
  emails: number
  filled: number
  updated: number
  errors: string[]
}

/**
 * Re-read the kept emails' HTML and fill the excerpt + summary of mentions
 * stored before excerpts were parsed. Cards already in Slack are edited in
 * place (chat.update, same message), never posted again. Safe to re-run:
 * only rows whose snippet is still empty are touched.
 */
export async function backfillExcerpts(summarize: Summarize = summarizeExcerpt, now: Date = new Date()): Promise<BackfillSummary> {
  const out: BackfillSummary = { ok: true, emails: 0, filled: 0, updated: 0, errors: [] }
  const emails = await listEmails()
  out.emails = emails.length
  const excerpts = new Map<string, string>()
  for (const e of emails) for (const [k, v] of extractF5Excerpts(e.html)) if (!excerpts.has(k)) excerpts.set(k, v)
  const rows = await mentionsMissingSnippet([...excerpts.keys()])
  if (!rows.length) return out

  let token: string | null = null
  if (rows.some((r) => r.slack_ts)) {
    const r = await resolveChannel(await getSignalConfig())
    if ('error' in r) out.errors.push(r.error)
    else token = r.token
  }

  for (const row of rows) {
    const excerpt = excerpts.get(row.permalink)
    if (!excerpt) continue
    try {
      const summary = await summarize({ title: row.title, excerpt, keyword: row.keyword })
      const updated = await fillMentionText(row.id, { snippet: clip(excerpt) ?? excerpt, summary, hot: row.hot || isHot(row.title, excerpt) })
      if (!updated) continue
      out.filled++
      if (token && updated.slack_ts && updated.slack_channel_id) {
        const card = buildRedditCard(updated, now)
        await slackApi('chat.update', token, { channel: updated.slack_channel_id, ts: updated.slack_ts, text: card.text, blocks: card.blocks })
        out.updated++
      }
    } catch (err) {
      out.errors.push(`mention ${row.id}: ${msg(err)}`)
    }
  }
  if (out.errors.length) out.ok = false
  return out
}
