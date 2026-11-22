/**
 * Chosen LinkedIn post URLs for an influencer run in URL mode (pure, client-safe).
 * Same rule as the `influencer-reactions` edge function: strip `?query` and
 * `#hash`, then a /posts/<slug> or /feed/update/urn:li:(activity|share|ugcPost):<id>
 * URL, optional trailing slash.
 */

export const MAX_POST_URLS = 10

export const POST_URL_RE = /^https:\/\/(www\.)?linkedin\.com\/(posts\/[A-Za-z0-9_%-]+|feed\/update\/urn:li:(activity|share|ugcPost):\d+)\/?$/

/** The canonical form (no query, hash or trailing slash), or null when it is not a LinkedIn post URL. */
export function normalizePostUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const u = raw.trim().replace(/#.*$/, '').replace(/\?.*$/, '')
  if (!POST_URL_RE.test(u)) return null
  return u.replace(/\/+$/, '')
}

export type PostUrlsCheck = { ok: true; urls: string[] } | { ok: false; error: string }

/** 1-10 valid post URLs, normalized and deduped (order kept). */
export function checkPostUrls(raw: unknown): PostUrlsCheck {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'post_urls must be a non-empty array' }
  const bad: string[] = []
  const urls: string[] = []
  for (const r of raw) {
    const u = typeof r === 'string' ? normalizePostUrl(r) : null
    if (u === null) bad.push(String(r).slice(0, 200))
    else if (!urls.includes(u)) urls.push(u)
  }
  if (bad.length) return { ok: false, error: `invalid post_urls (need linkedin.com/posts/... or /feed/update/urn:li:...): ${bad.join(', ')}` }
  if (urls.length > MAX_POST_URLS) return { ok: false, error: `post_urls: at most ${MAX_POST_URLS} posts per run (got ${urls.length})` }
  return { ok: true, urls }
}
