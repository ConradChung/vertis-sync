/**
 * GTM-15: F5Bot alert emails → Reddit mentions (pure, no I/O).
 *
 * F5Bot's email layout is not relied on: every Reddit post/comment link in
 * the email (plain text or HTML, direct or URL-encoded inside a redirect) is
 * a candidate, deduped on a canonical key. The facts (handle, subreddit,
 * text) come from Reddit's public JSON for that link; the email text around
 * a link is only the fallback snippet / keyword when Reddit can't be read.
 * Everything here is untrusted text; the card escapes it.
 */

export const KEYWORDS = ['appfolio', 'buildium'] as const
export const MAX_LINKS = 20
export const SNIPPET_MAX = 600

export interface RedditLink {
  /** Canonical, lowercase: https://www.reddit.com/r/<sub>/comments/<post>/_/[<comment>/] */
  key: string
  /** The link as found (slug kept), https://www.reddit.com/… */
  url: string
  kind: 'post' | 'comment'
  subreddit: string
  postId: string
  commentId: string | null
  /** Email text around the link (F5Bot's own text for this hit), cleaned. */
  context: string
  /** From F5Bot's hit line `(/r/sub/): 'Title' by author <link>`, when present. */
  f5Title: string | null
  f5Author: string | null
}

/** F5Bot's hit line ends right before the link: `(/r/Sub/): 'Thread title' by author_name`. */
const F5_HIT = /\(\/?r\/[A-Za-z0-9_]{2,21}\/?\):\s*'([\s\S]{1,300}?)'\s+by\s+([A-Za-z0-9_-]{3,20})\s*(?:https?:\/\/\S*)?\s*$/
export function parseF5Hit(before: string): { title: string | null; author: string | null } {
  const m = F5_HIT.exec(before)
  return m ? { title: m[1].replace(/\s+/g, ' ').trim() || null, author: m[2] } : { title: null, author: null }
}

const LINK = /https?:\/\/(?:[a-z0-9-]+\.)?reddit\.com\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{3,20})(?:\/([^/\s?#"'<>)&]*))?(?:\/([a-z0-9]{3,20}))?\/?/gi

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')

/** Percent-decode each encoded run on its own, so one stray % can't hide every link. */
function tryDecode(s: string): string {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}

/** HTML → text good enough for snippets (tags dropped, entities decoded). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * Every distinct Reddit post/comment link in the email, in order, at most
 * MAX_LINKS. `text` is the plain body; `html` (optional) adds hrefs that
 * only exist in the HTML part.
 */
export function extractRedditLinks(text: string, html = ''): RedditLink[] {
  const plain = decodeEntities(text ?? '')
  // Links inside redirects arrive URL-encoded; decoding a copy finds them too.
  const sources = [plain, tryDecode(plain), decodeEntities(html ?? ''), tryDecode(decodeEntities(html ?? ''))]
  const out: RedditLink[] = []
  const seen = new Set<string>()
  for (let si = 0; si < sources.length; si++) {
    const src = sources[si]
    const matches = [...src.matchAll(LINK)]
    for (let mi = 0; mi < matches.length; mi++) {
      const m = matches[mi]
      const [raw, sub, post, slug, comment] = m
      const at = m.index ?? 0
      const subreddit = sub
      const postId = post.toLowerCase()
      const commentId = comment ? comment.toLowerCase() : null
      const key = `https://www.reddit.com/r/${subreddit.toLowerCase()}/comments/${postId}/_/${commentId ? `${commentId}/` : ''}`
      // F5Bot's own text for this hit: what sits between the previous link and the next one.
      const prev = mi > 0 ? (matches[mi - 1].index ?? 0) + matches[mi - 1][0].length : 0
      const next = mi + 1 < matches.length ? (matches[mi + 1].index ?? src.length) : src.length
      const beforeRaw = src.slice(Math.max(prev, at - 400), at)
      const ctxRaw = `${beforeRaw} ${src.slice(at + raw.length, Math.min(next, at + raw.length + 400))}`
      if (seen.has(key)) continue
      seen.add(key)
      const url = `https://www.reddit.com/r/${subreddit}/comments/${post}/${slug || '_'}/${comment ? `${comment}/` : ''}`
      const context = si >= 2 ? clean(htmlToText(ctxRaw)) : clean(ctxRaw)
      const hit = parseF5Hit(si >= 2 ? clean(htmlToText(beforeRaw)) : clean(beforeRaw))
      out.push({ key, url, kind: commentId ? 'comment' : 'post', subreddit, postId, commentId, context: context.slice(-SNIPPET_MAX), f5Title: hit.title, f5Author: hit.author })
      if (out.length >= MAX_LINKS) return out
    }
  }
  return out
}

/** The first tracked keyword found in the texts (lowercase), or null. */
export function findKeyword(...texts: (string | null | undefined)[]): string | null {
  const all = texts.filter(Boolean).join(' ').toLowerCase()
  for (const k of KEYWORDS) if (all.includes(k)) return k
  return null
}

/** Complaint or shopping-around language: these cards get 🔥 and go first. */
const HOT = [
  /switch(?:ing|ed)?\s+(?:from|away|off)/i,
  /alternatives?\s+(?:to|for)/i,
  /\bhate\b/i,
  /migrat(?:e|ing|ion)/i,
  /moving\s+(?:away\s+)?from/i,
  /leaving\s+(?:appfolio|buildium)/i,
  /replac(?:e|ing)\s+(?:appfolio|buildium)/i,
  /frustrat/i,
  /fed up/i,
  /looking for (?:a |an )?(?:new|different|better|other)/i,
]
export function isHot(...texts: (string | null | undefined)[]): boolean {
  const all = texts.filter(Boolean).join(' ')
  return HOT.some((r) => r.test(all))
}

export const HANDLE = /^[A-Za-z0-9_-]{3,20}$/
/** A real, DM-able handle (not [deleted] / AutoModerator / junk). */
export function dmHandle(author: string | null | undefined): string | null {
  if (!author || !HANDLE.test(author)) return null
  if (/^automoderator$/i.test(author)) return null
  return author
}

const USER_LINK = /reddit\.com\/u(?:ser)?\/([A-Za-z0-9_-]{3,20})\b/i
const USER_TAG = /(?:^|[\s(])\/?u\/([A-Za-z0-9_-]{3,20})\b/
const BY = /\b(?:by|from|author:?)\s+\/?(?:u\/)?([A-Za-z0-9_-]{3,20})\b/i

/**
 * The author's handle when F5Bot's own text names it (a profile link,
 * `u/name`, or "by name"). Used when Reddit's JSON can't be read (Reddit
 * 403s anonymous requests from most servers).
 */
export function authorFromContext(context: string): string | null {
  for (const re of [USER_LINK, USER_TAG, BY]) {
    const h = re.exec(context)?.[1]
    if (h && dmHandle(h) && !/^(?:reddit|f5bot|the|a|an|keyword)$/i.test(h)) return h
  }
  return null
}

export interface RedditThing {
  author: string | null
  subreddit: string | null
  title: string | null
  text: string | null
  createdAt: string | null
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
const children = (listing: unknown): Obj[] => {
  const c = obj(obj(listing).data).children
  return Array.isArray(c) ? c.map((x) => obj(obj(x).data)) : []
}
const ts = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null)

/** Reddit's `<permalink>.json` ([post listing, comments listing]) → the thing the link points at. */
export function parseRedditJson(json: unknown, link: Pick<RedditLink, 'commentId'>): RedditThing | null {
  if (!Array.isArray(json) || json.length < 1) return null
  const post = children(json[0])[0]
  if (!post) return null
  const title = s(post.title)
  if (!link.commentId) {
    return { author: s(post.author), subreddit: s(post.subreddit), title, text: s(post.selftext) ?? title, createdAt: ts(post.created_utc) }
  }
  const c = children(json[1]).find((x) => String(x.id ?? '').toLowerCase() === link.commentId)
  if (!c) return null
  return { author: s(c.author), subreddit: s(c.subreddit) ?? s(post.subreddit), title, text: s(c.body), createdAt: ts(c.created_utc) }
}

export const clip = (t: string | null | undefined, n = SNIPPET_MAX) => {
  if (!t) return null
  const one = t.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}
