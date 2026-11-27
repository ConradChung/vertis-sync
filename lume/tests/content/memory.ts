import { vi } from 'vitest'
import { parseContentConfig, round4 } from '@/lib/content/config'
import type { AiResult, ContentStore, Deps, DraftRow } from '@/lib/content/engine'
import type { LeadUse } from '@/lib/content/facts'
import type { MatchPost } from '@/lib/content/match'
import { FACTS, goodDraft } from './fixtures'

export function memoryStore(cfgValue: unknown = {}, opts: { spent?: number; posts?: MatchPost[] } = {}) {
  const drafts: (DraftRow & { id: number; created_at: string; slack_ts?: string; posted_post_id?: string | null })[] = []
  const spend: { id: number; usd: number; draft_id: number | null }[] = opts.spent ? [{ id: 1, usd: opts.spent, draft_id: null }] : []
  const store: ContentStore = {
    getConfig: async () => parseContentConfig(cfgValue),
    activeFacts: async () => FACTS.filter((f) => f.active),
    leadUses: async (): Promise<LeadUse[]> => drafts.map((d) => ({ lead_fact_id: d.lead_fact_id, created_at: d.created_at, status: d.status })),
    monthSpend: async () => round4(spend.reduce((s, r) => s + r.usd, 0)),
    addSpend: async (r) => {
      const id = spend.length + 1
      spend.push({ id, usd: r.usd, draft_id: null })
      return id
    },
    linkSpend: async (ids, draftId) => {
      for (const s of spend) if (ids.includes(s.id)) s.draft_id = draftId
    },
    hasCronDraft: async (date) => drafts.some((d) => d.run_date === date && d.trigger === 'cron'),
    insertDraft: async (row) => {
      const id = drafts.length + 1
      drafts.push({ ...row, id, created_at: new Date().toISOString() })
      return id
    },
    setDraftSlack: async (id, _team, _channel, ts) => {
      drafts[id - 1].slack_ts = ts
    },
    recentPosts: async () => opts.posts ?? [],
    unmatchedDrafts: async () => drafts.filter((d) => d.body && !d.posted_post_id && d.status !== 'rejected').map((d) => ({ id: d.id, body: d.body!, created_at: d.created_at })),
    markPosted: async (id, postId) => {
      drafts[id - 1].posted_post_id = postId
      ;(drafts[id - 1] as { status: string }).status = 'posted'
      return true
    },
  }
  return { store, drafts, spend }
}

export const reply = (text: string | null, usd = 0.1, stop = 'end_turn'): AiResult => ({ text, stop, usd, input_tokens: 9000, output_tokens: 2000 })
export const good = (lead = 7) => JSON.stringify(goodDraft({ fact_ids: [lead, 1] }))

export function deps(store: ContentStore, replies: AiResult[]) {
  const write = vi.fn(async () => {
    const r = replies.shift()
    if (!r) throw new Error('no more replies')
    return r
  })
  const post = vi.fn(async () => ({ team: 'T082MHH6U5P', channel: 'C0CONTENT1', ts: '1700000000.000100' }))
  const d: Deps = { store, ai: { write }, slack: { post }, refs: () => ({ hookFormulas: 'H', humanizer: 'U', algorithm: 'A' }), model: 'claude-opus-5-5' }
  return { d, write, post }
}
