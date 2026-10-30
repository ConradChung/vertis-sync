// Stage 1-2: an influencer's posts (harvestapi~linkedin-profile-posts), Haiku
// PM-relevance, top 10 by likes. Pure. Ported from pm/posts.py.
import { buildJsonRequest, type JsonRequest } from './haiku.ts'

export interface PostRow {
  post_id: string
  post_url: string
  posted_at: string | null
  likes: number
  comments: number
  shares: number
  text: string
}

export function sinceIso(lookbackDays: number, now: Date = new Date()): string {
  return new Date(now.getTime() - lookbackDays * 86_400_000).toISOString().slice(0, 10)
}

export function buildPostsInput(linkedinUrl: string, lookbackDays: number, now: Date = new Date()): Record<string, unknown> {
  return {
    targetUrls: [linkedinUrl],
    maxPosts: 0,
    postedLimitDate: sinceIso(lookbackDays, now),
    includeReposts: false,
    includeQuotePosts: true,
    scrapeReactions: false,
    scrapeComments: false,
  }
}

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : {})
const int = (v: unknown) => Math.max(0, Math.floor(Number(v ?? 0) || 0))
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

export function flattenPosts(items: unknown[]): PostRow[] {
  const rows: PostRow[] = []
  for (const it of items) {
    const i = obj(it)
    if (i.type !== 'post') continue
    const id = str(i.id).trim()
    const url = str(i.linkedinUrl).trim()
    if (!id || !url) continue
    const eng = obj(i.engagement)
    rows.push({
      post_id: id,
      post_url: url,
      posted_at: str(obj(i.postedAt).date) || null,
      likes: int(eng.likes),
      comments: int(eng.comments),
      shares: int(eng.shares),
      text: str(i.content).trim().slice(0, 4000),
    })
  }
  return rows
}

export const RELEVANCE_SYSTEM = `You classify LinkedIn posts by property-management influencers.
A post is PM-relevant if its subject is property management operations, growth, pricing, staffing,
owners/investors as clients, maintenance, leasing, PM software, or the PM industry. Personal life,
generic motivation, and unrelated business topics are not PM-relevant. Be strict.`

export const RELEVANCE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { post_id: { type: 'string' }, pm_relevant: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['post_id', 'pm_relevant', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
}

export const RELEVANCE_BATCH = 20

const attr = (s: string) => s.replace(/[^A-Za-z0-9_:-]/g, '')

export function relevanceRequest(batch: { post_id: string; text: string | null }[]): JsonRequest {
  const lines = batch.map((r) => `<post id="${attr(r.post_id)}">\n${(r.text ?? '').slice(0, 1500)}\n</post>`)
  return buildJsonRequest(RELEVANCE_SYSTEM, 'Classify each post. Return one result per post id.\n\n' + lines.join('\n\n'), RELEVANCE_SCHEMA, 4096)
}

export type RelevanceLabels = Record<string, { pm_relevant: boolean; reason: string }>

export function parseRelevance(json: unknown): RelevanceLabels {
  const results = obj(json).results
  if (!Array.isArray(results)) throw new Error('relevance: results missing')
  const out: RelevanceLabels = {}
  for (const r of results) {
    const o = obj(r)
    if (typeof o.post_id === 'string' && typeof o.pm_relevant === 'boolean') {
      out[o.post_id] = { pm_relevant: o.pm_relevant, reason: str(o.reason).slice(0, 500) }
    }
  }
  return out
}

export function applyRelevance<T extends { post_id: string }>(rows: T[], labels: RelevanceLabels): (T & { pm_relevant: boolean; relevance_reason: string })[] {
  return rows.map((r) => {
    const l = labels[r.post_id] ?? { pm_relevant: false, reason: 'no label returned' }
    return { ...r, pm_relevant: l.pm_relevant, relevance_reason: l.reason }
  })
}

export function topN<T extends { pm_relevant?: boolean | null; likes?: number | null }>(rows: T[], n: number): (T & { rank: number })[] {
  return rows
    .filter((r) => r.pm_relevant === true)
    .sort((a, b) => Number(b.likes ?? 0) - Number(a.likes ?? 0))
    .slice(0, n)
    .map((r, i) => ({ ...r, rank: i + 1 }))
}
