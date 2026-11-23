// GTM-14: tolerant parser for harvestapi~linkedin-post-comments items. Pure.
//
// Item shape (actor README sample, build 0.0.37, 2026-11-22):
//   { type: 'comment', id, linkedinUrl (comment URL), commentary, createdAt,
//     createdAtTimestamp, postId, actor: { id, name, linkedinUrl, position, author } }
// Assumed (not in the sample): replies nested under `replies` (or `comments`)
// with the same shape, or emitted as top-level items of type 'reply' when
// scrapeReplies is on. Alternative field names are accepted where cheap.
import { clip } from '../text.ts'

export interface Commenter {
  linkedin_id: string | null
  linkedin_url: string
  name: string | null
  first_name: string | null
  headline: string | null
  comment_text: string | null
  commented_at: string | null
  comment_url: string | null
  post_id: string | null
  /** The post's author (actor.author === true). */
  is_author: boolean
}

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : {})
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const first = (o: Raw, keys: string[]) => {
  for (const k of keys) {
    const s = str(o[k])
    if (s) return s
  }
  return ''
}

/** The /in/<slug> of a LinkedIn profile URL, lowercased and decoded; null when not a profile URL. */
export function profileSlug(raw: string | null | undefined): string | null {
  const m = /linkedin\.com\/(?:in|pub)\/([^/?#\s]+)/i.exec(raw ?? '')
  if (!m) return null
  let slug = m[1]
  try {
    slug = decodeURIComponent(slug)
  } catch {
    // malformed escape: keep as written
  }
  slug = slug.trim().toLowerCase()
  return slug || null
}

/** https://www.linkedin.com/in/<slug>, or null. */
export function normalizeProfileUrl(raw: string | null | undefined): string | null {
  const slug = profileSlug(raw)
  return slug ? `https://www.linkedin.com/in/${encodeURIComponent(slug).replace(/%2D/gi, '-')}` : null
}

/** lead_review_items.linkedin_key format (lume/lib/leads/lists/model.ts linkedinKey): `in/<decoded slug>` lowercased. */
export function linkedinKey(raw: string | null | undefined): string | null {
  const m = /linkedin\.com\/(in|company|pub)\/([^/?#\s]+)/i.exec(raw ?? '')
  if (!m) return null
  let slug = m[2]
  try {
    slug = decodeURIComponent(slug)
  } catch {
    // keep
  }
  return `${m[1]}/${slug}`.toLowerCase()
}

/** First name from a display name: the first word with a letter, without honorifics or trailing punctuation. */
export function firstName(name: string | null | undefined): string | null {
  const words = (name ?? '').replace(/[^\p{L}\p{M}\s'.-]/gu, ' ').split(/\s+/).filter(Boolean)
  for (const w of words) {
    const clean = w.replace(/^[.'-]+|[.'-]+$/g, '')
    if (!clean || /^(mr|mrs|ms|dr|prof)$/i.test(clean)) continue
    if (/\p{L}/u.test(clean)) return clean.charAt(0).toUpperCase() + clean.slice(1)
  }
  return null
}

function toIso(v: unknown, ts: unknown): string | null {
  const s = str(v)
  if (s && Number.isFinite(Date.parse(s))) return new Date(s).toISOString()
  const n = Number(ts)
  if (Number.isFinite(n) && n > 1e11) return new Date(n).toISOString()
  return null
}

function one(it: Raw): Commenter | null {
  const type = str(it.type)
  if (type && type !== 'comment' && type !== 'reply') return null
  const actor = obj(it.actor ?? it.author ?? it.commenter)
  const id = first(actor, ['id', 'urn', 'profileId']) || null
  const url = normalizeProfileUrl(first(actor, ['linkedinUrl', 'profileUrl', 'url'])) ??
    (first(actor, ['publicIdentifier']) ? normalizeProfileUrl(`https://www.linkedin.com/in/${first(actor, ['publicIdentifier'])}`) : null) ??
    (id ? `https://www.linkedin.com/in/${encodeURIComponent(id)}` : null)
  if (!url) return null
  const name = first(actor, ['name', 'fullName']) || [str(actor.firstName), str(actor.lastName)].filter(Boolean).join(' ') || null
  const text = first(it, ['commentary', 'text', 'comment', 'content'])
  return {
    linkedin_id: id,
    linkedin_url: url,
    name: name ? clip(name, 200) : null,
    first_name: str(actor.firstName) || firstName(name),
    headline: first(actor, ['position', 'headline', 'occupation']) ? clip(first(actor, ['position', 'headline', 'occupation']), 500) : null,
    comment_text: text ? clip(text, 2000) : null,
    commented_at: toIso(it.createdAt, it.createdAtTimestamp),
    comment_url: first(it, ['linkedinUrl', 'commentUrl', 'url']) || null,
    post_id: first(it, ['postId']) || null,
    is_author: actor.author === true,
  }
}

/** Every comment and nested reply, in dataset order. Items that don't parse are dropped. */
export function parseComments(items: unknown[]): Commenter[] {
  const out: Commenter[] = []
  const walk = (it: unknown, depth: number) => {
    const o = obj(it)
    const c = one(o)
    if (c) out.push(c)
    if (depth > 2) return
    for (const k of ['replies', 'comments']) {
      const nested = o[k]
      if (Array.isArray(nested)) for (const r of nested) walk(r, depth + 1)
    }
  }
  for (const it of items) walk(it, 0)
  return out
}

/**
 * One entry per person (first comment wins), without Frank: the post author
 * flag, or his profile slug / id.
 */
export function commentersToConsider(comments: Commenter[], frank: { profileUrl: string; linkedinId?: string | null }): Commenter[] {
  const frankSlug = profileSlug(frank.profileUrl)
  const seen = new Set<string>()
  const out: Commenter[] = []
  for (const c of comments) {
    if (c.is_author) continue
    if (frankSlug && profileSlug(c.linkedin_url) === frankSlug) continue
    if (frank.linkedinId && c.linkedin_id === frank.linkedinId) continue
    const key = c.linkedin_id ?? c.linkedin_url
    if (seen.has(key) || seen.has(c.linkedin_url)) continue
    seen.add(key)
    seen.add(c.linkedin_url)
    out.push(c)
  }
  return out
}
