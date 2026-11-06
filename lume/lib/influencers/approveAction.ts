import 'server-only'
import { z } from 'zod'
import type { Json } from '@/lib/db/types'
import { approveCandidates, getCandidatesByIds } from '@/lib/influencers/candidateStore'
import type { InfluencerActionBuild } from '@/lib/influencers/actionPayload'

/**
 * `influencer_approve`: the agent's approve_influencer_candidates. Always asks:
 * sheet and web text reach the agent, so it never creates influencers on its
 * own (the /influencers page's approve button stays a direct owner click).
 *
 *  build    { candidate_ids } → only candidates found with a LinkedIn URL; the
 *           summary names each with its profile and confidence.
 *  execute  approveCandidates on exactly those ids: each still 'found' becomes
 *           an INACTIVE influencer (or is linked to the one with that profile);
 *           anything approved or rejected since is left alone.
 */

const Body = z.object({ candidate_ids: z.array(z.string().uuid()).min(1).max(1000) })
const fail = (status: number, error: string): InfluencerActionBuild => ({ ok: false, status, error })
const short = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '')

export async function buildInfluencerApprove(raw: Record<string, unknown>): Promise<InfluencerActionBuild> {
  const body = Body.safeParse(raw)
  if (!body.success) return fail(400, 'invalid_payload')
  const ids = [...new Set(body.data.candidate_ids.map((x) => x.toLowerCase()))]
  const rows = await getCandidatesByIds(ids)
  const ok = rows.filter((c) => c.status === 'found' && c.linkedin_url).sort((a, b) => (a.id < b.id ? -1 : 1))
  if (!ok.length) return fail(409, 'nothing_to_approve')
  const skipped = ids.length - ok.length
  const lines = ok.slice(0, 15).map((c) => `${c.name}${c.company ? ` (${c.company})` : ''} ${short(c.linkedin_url!)} · ${c.confidence ?? '?'}`)
  return {
    ok: true,
    kind: 'influencer_approve',
    payload: {
      candidate_ids: ok.map((c) => c.id),
      summary:
        `Approve ${ok.length} influencer candidate${ok.length === 1 ? '' : 's'} as INACTIVE influencers (nothing runs or is spent): ` +
        `${lines.join('; ')}${ok.length > 15 ? `; and ${ok.length - 15} more` : ''}.` +
        (skipped ? ` ${skipped} skipped (not found, already reviewed or no profile).` : ''),
    },
  }
}

export type ExecOutcome = { ok: true; result: Record<string, Json> } | { ok: false; error: string; result: Record<string, Json> }

export async function executeInfluencerApprove(p: Record<string, Json>): Promise<ExecOutcome> {
  const ids = Array.isArray(p.candidate_ids) ? p.candidate_ids.filter((x): x is string => typeof x === 'string') : []
  if (!ids.length) return { ok: false, error: 'payload.candidate_ids is missing', result: {} }
  const r = await approveCandidates(ids)
  return {
    ok: true,
    result: {
      approved: r.approved.length,
      created: r.approved.filter((a) => a.created).length,
      linked: r.approved.filter((a) => !a.created).length,
      skipped: r.skipped as unknown as Json,
    },
  }
}
