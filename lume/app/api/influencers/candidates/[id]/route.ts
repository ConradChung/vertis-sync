import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { estimateLookup } from '@/lib/influencers/candidates'
import { batchCounts, getCandidateBatch, listCandidates } from '@/lib/influencers/candidateStore'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'

/** GET `?status=` → one batch, its candidates (list order), per-status counts and the lookup estimate for the people still pending. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  const status = new URL(req.url).searchParams.get('status') ?? undefined
  try {
    const batch = await getCandidateBatch(id)
    if (!batch) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const [candidates, counts] = await Promise.all([listCandidates(id, status), batchCounts(id)])
    return NextResponse.json({ batch, candidates, counts, estimate: estimateLookup(counts.pending_lookup ?? 0) })
  } catch (err) {
    return dbErrorResponse(err, 'api/influencers/candidates/[id]')
  }
}
