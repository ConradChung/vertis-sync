import 'server-only'
import { slackApi } from '@/lib/slack/api'
import { resolveChannel } from '@/lib/signal/alerts'
import { getSignalConfig } from '@/lib/signal/store'
import { buildRedditCard } from '@/lib/reddit/card'
import { authorFromContext, clip, extractRedditLinks, findKeyword, isHot, parseRedditJson, type RedditLink, type RedditThing } from '@/lib/reddit/parse'
import { claimMention, existingKeys, insertMention, listUnalerted, markMentionPosted, releaseMention } from '@/lib/reddit/store'

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

export async function ingestF5bot(email: F5botEmail, fetchThing: RedditFetch = fetchRedditThing, now: Date = new Date()): Promise<IngestSummary> {
  const cfg = await getSignalConfig()
  const live = cfg.raw.reddit_live === true
  const out: IngestSummary = { ok: true, live, links: 0, inserted: 0, duplicate: 0, unreadable: 0, posted: 0, dry_run: 0, failed: 0, errors: [] }

  const links = extractRedditLinks(email.body ?? '', email.html ?? '')
  out.links = links.length
  const known = await existingKeys(links.map((l) => l.key))

  for (const link of links) {
    if (known.has(link.key)) {
      out.duplicate++
      continue
    }
    let thing: RedditThing | null = null
    let fetchError: string | null = null
    try {
      thing = await fetchThing(link)
      if (!thing) fetchError = 'not_found'
    } catch (err) {
      fetchError = msg(err)
    }
    if (fetchError) out.unreadable++
    // F5Bot's plain email has no excerpt: without Reddit's text the card shows the title only.
    const title = clip(thing?.title ?? link.f5Title, 300)
    const snippet = clip(thing?.text)
    const inserted = await insertMention({
      permalink: link.key,
      url: link.url,
      kind: link.kind,
      subreddit: thing?.subreddit ?? link.subreddit,
      author: thing?.author ?? link.f5Author ?? authorFromContext(link.context),
      title,
      snippet,
      keyword: findKeyword(title, thing?.text) ?? findKeyword(link.context, email.subject),
      hot: isHot(title, thing?.text),
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
