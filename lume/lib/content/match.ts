/**
 * Tie a draft to the post Frank actually published (pure). The signal
 * pipeline already stores his posts in signal_posts (text_excerpt is the
 * first 500 characters). A post matches a draft when their opening words
 * overlap closely: Frank may tweak a word or two, but the hook survives.
 */

export const MATCH_THRESHOLD = 0.6
const WINDOW = 500

const words = (s: string) =>
  s
    .slice(0, WINDOW)
    .toLowerCase()
    .replace(/[’']/g, '')
    .match(/[a-z0-9]+/g) ?? []

/** Jaccard overlap of word pairs (bigrams) in the first 500 characters, 0..1. */
export function similarity(a: string, b: string): number {
  const pairs = (s: string) => {
    const w = words(s)
    const out = new Set<string>()
    for (let i = 0; i + 1 < w.length; i++) out.add(`${w[i]} ${w[i + 1]}`)
    return out
  }
  const A = pairs(a)
  const B = pairs(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

export interface MatchPost {
  post_id: string
  text_excerpt: string | null
  posted_at: string
}

export interface MatchDraft {
  id: number
  body: string
  created_at: string
}

/** Pairs (draft, post) above the threshold, best first, each draft and post used once; a post must come after its draft. */
export function matchPosts(posts: MatchPost[], drafts: MatchDraft[], threshold = MATCH_THRESHOLD): { draft_id: number; post_id: string; posted_at: string; score: number }[] {
  const scored: { draft_id: number; post_id: string; posted_at: string; score: number }[] = []
  for (const p of posts) {
    if (!p.text_excerpt) continue
    for (const d of drafts) {
      if (new Date(p.posted_at).getTime() < new Date(d.created_at).getTime()) continue
      // Compare the post's excerpt against the same span of the draft.
      const score = similarity(d.body.slice(0, p.text_excerpt.length), p.text_excerpt)
      if (score >= threshold) scored.push({ draft_id: d.id, post_id: p.post_id, posted_at: p.posted_at, score })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const usedD = new Set<number>()
  const usedP = new Set<string>()
  return scored.filter((s) => {
    if (usedD.has(s.draft_id) || usedP.has(s.post_id)) return false
    usedD.add(s.draft_id)
    usedP.add(s.post_id)
    return true
  })
}
