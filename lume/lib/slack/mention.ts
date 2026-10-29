import 'server-only'
import { alert, alertLink, gateKey } from '@/lib/alerts'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import { listVerticals } from '@/lib/operators/store'
import { slackApi } from '@/lib/slack/api'
import { channelCampaigns } from '@/lib/slack/binding'
import { esc, FIELD_LABEL, parseVisibleFields, type CardField, type LeadFacts } from '@/lib/slack/card'
import { draftOf, storedFacts } from '@/lib/slack/post'
import { getAction } from '@/lib/actions/store'
import { getBinding, getBotToken, getInstall, getPostByTs } from '@/lib/slack/store'

/**
 * `@Lume <question>` in a client channel (3g): a DETERMINISTIC, read-only
 * lead lookup, scoped to the campaigns the channel is bound to. Decision:
 * no LLM. A model answering a client could be talked into reading outside
 * the scope or into "just enriching it"; a fixed lookup cannot, costs
 * nothing, and is enough for "what's the status of this lead?" questions.
 *
 *  - In the thread of a lead post: that lead's card (visible fields only),
 *    the reply's status and the draft's status.
 *  - Anywhere else: the bound campaigns' positive replies matching the words
 *    (name or company), else the five newest; visible fields only.
 *  - Asking for enrichment (find an email / phone, enrich, Apollo): nothing
 *    is run. Lume tells the client it went to Conrad, and raises an
 *    owner-only feed item for him to decide (paid work always waits on him).
 * Never posts an email address; every value is escaped.
 */

export const ENRICH_INTENT = /\b(enrich\w*|apollo|clay|find (?:their|his|her|the|an?)? ?(?:e-?mail|phone|number|mobile|cell)|(?:phone|mobile|cell) number|direct dial|look ?up (?:their|his|her|the)? ?(?:e-?mail|phone))\b/i

/** The question without the bot mention, collapsed. */
export function cleanQuestion(text: string): string {
  return text.replace(/<@[UW][A-Z0-9]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
}

/** Search words: letters, digits, spaces, dot, apostrophe and hyphen only (nothing reaches a filter unescaped). */
export function searchTerm(q: string): string | null {
  const stop = /\b(what's|whats|what|is|the|status|of|on|for|with|any|about|lead|leads|reply|replies|show|me|list|latest|new|who|how|did|does|please|update|a|an|at|from|lume)\b/gi
  const t = q.replace(/[^\p{L}\p{N} .'-]/gu, ' ').replace(stop, ' ').replace(/(^|\s)['.-]+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length >= 2 ? t.slice(0, 60) : null
}

const STATUS_TEXT: Record<string, string> = {
  awaiting: 'a reply is drafted and awaits approval',
  approved: 'a reply was approved and is being sent',
  executing: 'a reply is being sent',
  executed: 'a reply was sent',
  rejected: 'the drafted reply was skipped',
  failed: 'the reply could not be sent; Conrad is looking at it',
  expired: 'the drafted reply expired',
}

export function leadAnswer(facts: LeadFacts, visible: readonly CardField[], status: string | null, handled: string | null): string {
  const lines = visible.filter((f) => f !== 'reply').map((f) => `*${FIELD_LABEL[f]}:* ${facts[f] ? esc(facts[f]!.replace(/\s+/g, ' ').slice(0, 300)) : '_missing_'}`)
  const state = status ? STATUS_TEXT[status] ?? status : handled ? `handled (${esc(handled.replace(/^label:/, ''))})` : 'no reply drafted yet'
  lines.push(`*Status:* ${state}`)
  return lines.join('\n')
}

export const ENRICH_REPLY = "Enrichment costs money, so I don't run it from Slack. I've passed your request to Conrad to approve."

interface ReplyHit {
  reply_to_uuid: string
  lead_name: string | null
  company: string | null
  received_at: string
  handled_how: string | null
}

async function searchReplies(campaigns: string[], term: string | null): Promise<ReplyHit[]> {
  const sb = createServiceClient()
  const cols = 'reply_to_uuid, lead_name, company, received_at, handled_how'
  const base = () => sb.from('lume_replies').select(cols).in('campaign_id', campaigns)
  const like = term ? `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null
  const results = like
    ? await Promise.all([base().ilike('lead_name', like).order('received_at', { ascending: false }).limit(5), base().ilike('company', like).order('received_at', { ascending: false }).limit(5)])
    : [await base().order('received_at', { ascending: false }).limit(5)]
  const out = new Map<string, ReplyHit>()
  for (const r of results) {
    if (r.error) throw new DbError('slack.searchReplies', r.error)
    for (const row of (r.data ?? []) as ReplyHit[]) out.set(row.reply_to_uuid, row)
  }
  return [...out.values()].sort((a, b) => (a.received_at < b.received_at ? 1 : -1)).slice(0, 5)
}

export interface MentionEvent {
  team: string
  channel: string
  user: string
  text: string
  ts: string
  thread_ts: string | null
}

/** Answer one mention in its thread. Returns the text posted (tests), or null when nothing was posted. */
export async function answerMention(ev: MentionEvent): Promise<string | null> {
  const bot = await getBotToken(ev.team)
  if (!bot) return null
  const reply = async (text: string) => {
    await slackApi('chat.postMessage', bot.token, { channel: ev.channel, thread_ts: ev.thread_ts ?? ev.ts, text, unfurl_links: false, unfurl_media: false })
    return text
  }
  const [binding, install, verticals] = await Promise.all([getBinding(ev.team, ev.channel), getInstall(ev.team), listVerticals()])
  if (!binding || !install || install.revoked_at) return reply("This channel isn't connected to Lume yet. Conrad connects channels.")
  const campaigns = channelCampaigns(binding, verticals)
  if (!campaigns.length) return reply('This channel has no campaigns connected right now.')
  const question = cleanQuestion(ev.text)
  const visible = parseVisibleFields(binding.visible_fields)

  const post = ev.thread_ts ? await getPostByTs(ev.team, ev.channel, ev.thread_ts) : null
  const postCampaign = typeof post?.card.campaign_id === 'string' ? post.card.campaign_id : null
  const inScopePost = post && postCampaign && campaigns.includes(postCampaign) ? post : null

  if (ENRICH_INTENT.test(question)) {
    const subject = inScopePost ? storedFacts(inScopePost.card).facts : null
    const who = subject && visible.includes('name') && subject.name ? subject.name : 'a lead'
    const title = `Client asked for enrichment in Slack (${who})`
    try {
      await alert({
        source: 'lume.slack', severity: 'urgent', title,
        body: `${title}\nWorkspace ${ev.team}, channel ${ev.channel}, user ${ev.user}.\nQuestion: “${question.slice(0, 300)}”\nNothing was run. Enrich it from Lume if you want to (paid).`,
        link: alertLink('/settings/slack'), campaign_id: postCampaign ?? campaigns[0], scope: 'replies', owner_only: true,
        dedupe_key: gateKey(`${ev.team}:${ev.channel}:${ev.thread_ts ?? ev.ts}`, 'slack_enrich'),
      })
    } catch (err) {
      console.error('[slack/mention] enrichment request alert failed:', err instanceof Error ? err.message : err)
    }
    return reply(ENRICH_REPLY)
  }

  if (inScopePost) {
    const { facts } = storedFacts(inScopePost.card)
    const action = inScopePost.action_id ? await getAction(inScopePost.action_id) : null
    const draft = draftOf(action)
    const replyRow = await createServiceClient().from('lume_replies').select('handled_how').eq('reply_to_uuid', inScopePost.reply_to_uuid).maybeSingle()
    const handled = (replyRow.data as { handled_how: string | null } | null)?.handled_how ?? null
    return reply(leadAnswer(facts, visible, draft.kind === 'action' ? draft.status : null, handled))
  }

  const term = searchTerm(question)
  const hits = await searchReplies(campaigns, term)
  if (!hits.length) return reply(term ? `No positive replies match “${esc(term)}” in this channel's campaigns.` : 'No positive replies yet in this channel\'s campaigns.')
  const showName = visible.includes('name')
  const showCompany = visible.includes('company')
  const lines = hits.map((h) => {
    const who = [showName ? h.lead_name : null, showCompany && h.company ? `(${h.company})` : null].filter(Boolean).join(' ') || 'A lead'
    const when = h.received_at.slice(0, 10)
    const state = h.handled_how ? (h.handled_how === 'replied' ? 'replied' : `handled: ${h.handled_how.replace(/^label:/, '')}`) : 'open'
    return `• ${esc(who)} — ${when} — ${esc(state)}`
  })
  return reply(`${term ? `Positive replies matching “${esc(term)}”:` : 'Latest positive replies:'}\n${lines.join('\n')}\n_Mention me in a lead's thread for its details._`)
}
