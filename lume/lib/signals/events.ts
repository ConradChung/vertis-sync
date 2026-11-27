import type { SignalEvent } from '@/lib/signals/merge'

/**
 * Source rows → signal events (pure). Each mapper reads only the columns the
 * inbox shows and decides which rows count as a signal at all. Scraped text
 * is shortened and passed through as plain text.
 */

const clip = (v: string | null | undefined, n: number) => {
  const s = (v ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s
}

// ── signal_hiring ──────────────────────────────────────────────────────────

export const HIRING_COLS =
  'id, signal, role_title, headline, source_url, posted_at, company_name, company_domain, company_website, company_phone, person_name, person_title, person_linkedin, stage, skip_reason, status, created_at'

export interface HiringSource {
  id: number
  signal: string
  role_title: string | null
  headline: string | null
  source_url: string | null
  posted_at: string | null
  company_name: string | null
  company_domain: string | null
  company_website: string | null
  company_phone: string | null
  person_name: string | null
  person_title: string | null
  person_linkedin: string | null
  stage: string
  skip_reason: string | null
  status: string
  created_at: string
}

const HIRING_WORD: Record<string, string> = { hiring: 'Hiring', new_manager: 'New manager', expansion: 'Expansion' }

/** A finished row the pipeline kept and the owner has not skipped in the hiring sheet. */
export function hiringEvent(r: HiringSource): SignalEvent | null {
  if (r.stage !== 'done' || r.skip_reason || r.status === 'skipped') return null
  const what = clip(r.role_title ?? r.headline, 120)
  return {
    source: 'hiring',
    ref: `hiring:${r.id}`,
    company: r.company_name,
    site: r.company_domain ?? r.company_website,
    at: r.posted_at ?? r.created_at,
    label: [HIRING_WORD[r.signal] ?? 'Hiring signal', what].filter(Boolean).join(': '),
    url: r.source_url,
    phone: r.company_phone,
    person: r.person_name,
    person_title: r.person_title,
    linkedin: r.person_linkedin,
    detail: { source: 'hiring', signal: HIRING_WORD[r.signal] ?? 'Hiring signal', role: what || null },
  }
}

// ── signal_people (+ signal_posts) ─────────────────────────────────────────

export const PERSON_COLS = 'id, kind, stage, skip_reason, name, title, linkedin_url, company_name, company_website, post_id, comment_text, comment_url, commented_at, created_at'
export const POST_COLS = 'post_id, post_url, text_excerpt'

export interface PersonSource {
  id: number
  kind: string
  stage: string
  skip_reason: string | null
  name: string | null
  title: string | null
  linkedin_url: string | null
  company_name: string | null
  company_website: string | null
  post_id: string | null
  comment_text: string | null
  comment_url: string | null
  commented_at: string | null
  created_at: string
}
export interface PostSource {
  post_id: string
  post_url: string | null
  text_excerpt: string | null
}

/** A commenter or reactor on a watched post that the filter kept (not skipped, not errored). */
export function personEvent(r: PersonSource, posts: ReadonlyMap<string, PostSource>): SignalEvent | null {
  if (r.skip_reason || r.stage === 'skipped' || r.stage === 'error') return null
  // The ICP gate: only ready/alerted people passed it; 'held' waits on the owner's typed unit count.
  const gate: SignalEvent['gate'] = r.stage === 'ready' || r.stage === 'alerted' ? 'passed' : r.stage === 'held' ? 'held' : 'pending'
  const post = r.post_id ? posts.get(r.post_id) : undefined
  const said = clip(r.comment_text, 140)
  const label = r.kind === 'reactor' ? 'Reacted to a watched post' : said ? `Commented: “${said}”` : 'Commented on a watched post'
  return {
    source: 'comment',
    ref: `comment:${r.id}`,
    company: r.company_name,
    site: r.company_website,
    at: r.commented_at ?? r.created_at,
    label,
    url: r.comment_url ?? post?.post_url ?? null,
    phone: null,
    person: r.name,
    person_title: r.title,
    linkedin: r.linkedin_url,
    gate,
    person_id: r.id,
    detail: { source: 'comment', reaction: r.kind === 'reactor', comment: clip(r.comment_text, 280) || null, post_url: post?.post_url ?? null, post_excerpt: clip(post?.text_excerpt, 160) || null },
  }
}

// ── signal_reddit_mentions ─────────────────────────────────────────────────

export const REDDIT_COLS = 'id, url, permalink, subreddit, author, title, summary, snippet, alert_status, reddit_created_at, created_at'

export interface RedditSource {
  id: number
  url: string | null
  permalink: string | null
  subreddit: string | null
  author: string | null
  title: string | null
  summary: string | null
  snippet: string | null
  alert_status: string | null
  reddit_created_at: string | null
  created_at: string
}

/** A mention nobody skipped. It has no company: the author is the account. */
export function redditEvent(r: RedditSource): SignalEvent | null {
  if (r.alert_status === 'skipped' || !r.author?.trim()) return null
  const what = clip(r.summary ?? r.title ?? r.snippet, 140)
  return {
    source: 'reddit',
    ref: `reddit:${r.id}`,
    company: null,
    site: null,
    at: r.reddit_created_at ?? r.created_at,
    label: [r.subreddit ? `r/${r.subreddit.replace(/^r\//, '')}` : 'Reddit', what].filter(Boolean).join(': '),
    url: r.url ?? r.permalink,
    phone: null,
    person: null,
    person_title: null,
    linkedin: null,
    handle: r.author,
    detail: {
      source: 'reddit',
      subreddit: r.subreddit ? r.subreddit.replace(/^r\//, '') : null,
      thread: clip(r.title, 160) || null,
      excerpt: clip(r.snippet ?? r.summary, 280) || null,
      author: r.author,
    },
  }
}

// ── influencer_reactors ────────────────────────────────────────────────────

export const REACTOR_COLS = 'id, name, title, linkedin_url, company_name, company_website, reacted_to, door_count, verdict, verified_at, updated_at'

export interface ReactorSource {
  id: number
  name: string | null
  title: string | null
  linkedin_url: string | null
  company_name: string | null
  company_website: string | null
  reacted_to: string[] | null
  door_count: number | null
  verdict: string | null
  verified_at: string | null
  updated_at: string | null
}

const titled = (slug: string) => slug.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\d+$/, '').trim()

/** A verified reactor (a property manager who reacted to an influencer's post). Rejected and untriaged ones are not signals. */
export function reactorEvent(r: ReactorSource): SignalEvent | null {
  if (r.verdict !== 'verified') return null
  const who = (r.reacted_to ?? []).filter(Boolean).slice(0, 2).map(titled)
  const more = (r.reacted_to?.length ?? 0) - who.length
  const doors = typeof r.door_count === 'number' && r.door_count > 0 ? ` · ${r.door_count.toLocaleString('en-US')} doors` : ''
  return {
    source: 'influencer',
    ref: `influencer:${r.id}`,
    company: r.company_name,
    site: r.company_website,
    at: r.verified_at ?? r.updated_at,
    label: `Reacted to ${who.length ? who.join(', ') : 'an influencer'}${more > 0 ? ` +${more}` : ''}${doors}`,
    url: r.linkedin_url,
    phone: null,
    person: r.name,
    person_title: r.title,
    linkedin: r.linkedin_url,
    detail: { source: 'influencer', reacted_to: (r.reacted_to ?? []).filter(Boolean).map(titled), doors: typeof r.door_count === 'number' && r.door_count > 0 ? r.door_count : null },
  }
}
