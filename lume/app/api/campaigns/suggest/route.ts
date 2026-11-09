import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getCampaignSuggestion, type SuggestSource } from '@/lib/campaigns/suggestData'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'

/**
 * GET /api/campaigns/suggest[?job_id=|?list_id=] → { source, profile,
 * verticals (ranked, with why), suggestion, options, instantly }.
 * Read-only: what the New campaign sheet and the agent's
 * suggest_campaign_setup show before anything is filed. No params → the
 * options and defaults only (no lead profile).
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const q = new URL(req.url).searchParams
  const rawJob = q.get('job_id')
  const rawList = q.get('list_id')
  if (rawJob && rawList) return NextResponse.json({ error: 'one_source' }, { status: 400 })
  let src: SuggestSource = null
  if (rawJob) {
    const id = uuidParam(rawJob)
    if (!id) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
    src = { job_id: id }
  } else if (rawList) {
    const id = uuidParam(rawList)
    if (!id) return NextResponse.json({ error: 'bad_list_id' }, { status: 400 })
    src = { list_id: id }
  }
  try {
    const out = await getCampaignSuggestion(src, { withSources: q.get('sources') !== '0' })
    if (!out) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json(out)
  } catch (err) {
    return dbErrorResponse(err, 'api/campaigns/suggest')
  }
}
