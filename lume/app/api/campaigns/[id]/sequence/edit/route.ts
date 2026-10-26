import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured } from '@/lib/adapters/instantly'
import { getSequenceFresh } from '@/lib/adapters/instantlySequences'
import { findAwaitingActionBy } from '@/lib/campaigns/service'
import { toEditSteps } from '@/lib/campaigns/sequence'
import { instantlyErrorResponse, notConfigured } from '@/lib/http/instantly'
import { CAMPAIGN_ID_RE } from '@/lib/rules/schema'

/**
 * The full sequence of an Instantly campaign for the editor (and the agent's
 * `get_campaign_sequence`): every step and variant as plain text, read fresh
 * (uncached), with the hash an edit must be filed against and any edit
 * already awaiting approval. Read-only; saving goes through
 * `POST /api/actions` kind `update_sequence`.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const { id } = await ctx.params
  if (!CAMPAIGN_ID_RE.test(id)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  if (!isInstantlyConfigured()) return notConfigured()
  try {
    const [seq, pending] = await Promise.all([
      getSequenceFresh(id),
      findAwaitingActionBy('update_sequence', 'campaign_id', id).catch(() => null),
    ])
    return NextResponse.json({
      configured: true,
      campaign_id: id,
      name: seq.name,
      hash: seq.hash,
      steps: toEditSteps(seq.steps),
      pending: pending ? { id: pending.id, summary: pending.payload?.summary ?? null, created_at: pending.created_at } : null,
    })
  } catch (err) {
    return instantlyErrorResponse(err, 'api/campaigns/[id]/sequence/edit')
  }
}
