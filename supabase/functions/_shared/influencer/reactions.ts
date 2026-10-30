// Stage 3-4: reactions on the top posts (harvestapi~linkedin-post-reactions),
// flattened and deduped per influencer. Pure. Ported from pm/reactions.py.
//
// The actor returns postId as a URN (urn:li:activity:123) and the queried post
// URL under query.post; the join is on the URL.

export interface ReactionRow {
  post_id: string
  post_url: string
  reaction_type: string
  reactor_id: string
  reactor_name: string
  reactor_url: string
  reactor_headline: string
}

/** One reactor of one influencer's dataset, as lume_influencer_merge_reactions takes it. */
export interface MergeRow {
  linkedin_url: string
  linkedin_id: string
  name: string
  headline: string
  slug: string
  post_ids: string[]
}

export function buildReactionsInput(postUrls: string[], maxItems: number): Record<string, unknown> {
  return { posts: [...postUrls], maxItems: Math.floor(maxItems), profileScraperMode: 'short' }
}

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : {})
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

export function flattenReactions(items: unknown[], postUrlById: Record<string, string>): ReactionRow[] {
  const idByUrl: Record<string, string> = {}
  for (const [id, url] of Object.entries(postUrlById)) idByUrl[url] = id
  const rows: ReactionRow[] = []
  for (const it of items) {
    const i = obj(it)
    const actor = obj(i.actor)
    const reactorId = str(actor.id).trim()
    if (!reactorId) continue
    let postUrl = str(obj(i.query).post).trim()
    const rawId = str(i.postId).split(':').pop() ?? ''
    const postId = idByUrl[postUrl] ?? rawId
    if (!postUrl) postUrl = postUrlById[postId] ?? ''
    rows.push({
      post_id: postId,
      post_url: postUrl,
      reaction_type: str(i.reactionType),
      reactor_id: reactorId,
      reactor_name: str(actor.name),
      reactor_url: str(actor.linkedinUrl),
      reactor_headline: str(actor.position).trim(),
    })
  }
  return rows
}

const LINKEDIN_RE = /^https:\/\/(www\.)?linkedin\.com\//i

/** Dedupe one influencer's reactions by LinkedIn URL, keeping the distinct posts each reacted to. */
export function aggregateReactors(rows: ReactionRow[], slug: string): MergeRow[] {
  const agg = new Map<string, MergeRow>()
  for (const r of rows) {
    const url = (r.reactor_url || (r.reactor_id ? `https://www.linkedin.com/in/${r.reactor_id}` : '')).trim()
    if (!LINKEDIN_RE.test(url)) continue
    let a = agg.get(url)
    if (!a) {
      a = { linkedin_url: url, linkedin_id: r.reactor_id, name: r.reactor_name, headline: r.reactor_headline, slug, post_ids: [] }
      agg.set(url, a)
    }
    if (r.post_id && !a.post_ids.includes(r.post_id)) a.post_ids.push(r.post_id)
    if (!a.headline && r.reactor_headline) a.headline = r.reactor_headline
  }
  return [...agg.values()]
}
