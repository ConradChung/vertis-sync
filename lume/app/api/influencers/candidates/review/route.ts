import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { approveCandidates, rejectCandidates } from '@/lib/influencers/candidateStore'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'

/**
 * POST `{ action: 'approve' | 'reject', ids }`. Approve: each 'found'
 * candidate becomes an INACTIVE influencer (or is linked to the one that
 * already has its profile); nothing runs until the owner activates it and
 * approves a run. Reject: the candidate is marked rejected. No spend.
 */
const Body = z.object({ action: z.enum(['approve', 'reject']), ids: z.array(z.string().uuid()).min(1).max(1000) }).strict()

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, Body, 64 * 1024)
  if (!body.ok) return body.response
  const ids = [...new Set(body.data.ids.map((x) => x.toLowerCase()))]
  try {
    if (body.data.action === 'approve') return NextResponse.json(await approveCandidates(ids))
    return NextResponse.json({ rejected: await rejectCandidates(ids) })
  } catch (err) {
    return dbErrorResponse(err, 'api/influencers/candidates/review')
  }
}
