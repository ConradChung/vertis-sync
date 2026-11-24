import type { Block } from '@/lib/slack/card'
import { esc } from '@/lib/slack/card'
import { relTime, safeUrl, who } from '@/lib/slack/signalCard'
import { clip, dmHandle } from '@/lib/reddit/parse'

/**
 * GTM-15: the #sales card for one Reddit mention. Every Reddit field is
 * third-party text: escaped, clipped, links only through safeUrl. Nothing is
 * sent from here; "DM on Reddit" opens Reddit's compose page for a person to
 * write by hand. Mark contacted / Skip only record the decision.
 */

export const REDDIT_ACTION_IDS = { contacted: 'reddit_contacted', skip: 'reddit_skip' } as const
export const REDDIT_FOOTER = 'Nothing is sent automatically. DM them by hand on Reddit.'

export interface RedditMentionRow {
  id: number
  url: string
  kind: 'post' | 'comment'
  subreddit: string | null
  author: string | null
  title: string | null
  snippet: string | null
  summary?: string | null
  keyword: string | null
  hot: boolean
  reddit_created_at: string | null
  alert_status: string | null
  decided_by: string | null
}

const link = (url: string | null, label: string) => (url && safeUrl(url) ? `<${url}|${esc(label)}>` : esc(label))
const SUB = /^[A-Za-z0-9_]{2,21}$/

export function dmUrl(author: string | null): string | null {
  const h = dmHandle(author)
  return h ? `https://www.reddit.com/message/compose/?to=${h}` : null
}

export function buildRedditCard(r: RedditMentionRow, now: Date = new Date()): { text: string; blocks: Block[] } {
  const handle = dmHandle(r.author)
  const sub = r.subreddit && SUB.test(r.subreddit) ? r.subreddit : null
  const who_ = handle ? `*${link(`https://www.reddit.com/user/${handle}`, `u/${handle}`)}*` : '*unknown handle* (open the thread)'
  const bits = [who_]
  if (sub) bits.push(link(`https://www.reddit.com/r/${sub}`, `r/${sub}`))
  if (r.keyword) bits.push(`\`${esc(r.keyword)}\``)
  bits.push(r.kind === 'comment' ? 'comment' : 'post')
  const when = relTime(r.reddit_created_at, now)
  if (when) bits.push(when)
  const head = `${r.hot ? '🔥 ' : ''}${bits.join(' · ')}`

  const blocks: Block[] = [{ type: 'section', text: { type: 'mrkdwn', text: head } }]
  const title = clip(r.title, 200)
  if (title) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${esc(title)}*` } })
  const summary = clip(r.summary, 200)
  if (summary) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `💬 ${esc(summary)}` } })
  const snip = clip(r.snippet, 600)
  if (snip && snip !== title) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `>${esc(snip)}` } })

  const thread = safeUrl(r.url)
  const dm = dmUrl(r.author)
  const links: Block[] = []
  if (thread) links.push({ type: 'button', action_id: 'reddit_open', url: thread, text: { type: 'plain_text', text: 'Open thread' } })
  if (dm) links.push({ type: 'button', action_id: 'reddit_dm', url: dm, text: { type: 'plain_text', text: 'DM on Reddit' } })

  const open = r.alert_status === 'posted' || r.alert_status === 'dry_run' || r.alert_status === null
  const value = String(r.id)
  const actions: Block[] = [...links]
  if (open) {
    actions.push(
      { type: 'button', action_id: REDDIT_ACTION_IDS.contacted, style: 'primary', value, text: { type: 'plain_text', text: 'Mark contacted' } },
      { type: 'button', action_id: REDDIT_ACTION_IDS.skip, value, text: { type: 'plain_text', text: 'Skip' } }
    )
  }
  if (actions.length) blocks.push({ type: 'actions', block_id: 'reddit_decide', elements: actions })

  const status =
    r.alert_status === 'contacted' ? `✅ Contacted · ${who(r.decided_by)}` : r.alert_status === 'skipped' ? `⏭️ Skipped · ${who(r.decided_by)}` : REDDIT_FOOTER
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: status }] })

  const text = `${r.hot ? '🔥 ' : ''}Reddit${sub ? ` r/${sub}` : ''}: ${handle ? `u/${handle}` : 'mention'}${r.keyword ? ` on ${r.keyword}` : ''}`
  return { text, blocks }
}
