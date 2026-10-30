import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { InfluencerPatchBody, Slug } from '@/lib/influencers/schemas'
import { DuplicateInfluencerError, updateInfluencer } from '@/lib/influencers/store'

/**
 * `PATCH /api/influencers/<slug>` `{ name?, linkedin_url?, lookback_days?,
 * max_reactions_per_post?, active?, notes? }` → `{ influencer }`; 404 unknown
 * slug, 409 duplicate URL. Inert: it changes what the next run uses.
 */
type Ctx = { params: Promise<{ slug: string }> }

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const slug = Slug.safeParse((await ctx.params).slug)
  if (!slug.success) return NextResponse.json({ error: 'invalid_slug' }, { status: 400 })
  const body = await parseJsonBody(req, InfluencerPatchBody, 8 * 1024)
  if (!body.ok) return body.response
  try {
    const influencer = await updateInfluencer(slug.data, body.data)
    return influencer ? NextResponse.json({ influencer }) : NextResponse.json({ error: 'not_found' }, { status: 404 })
  } catch (err) {
    if (err instanceof DuplicateInfluencerError) return NextResponse.json({ error: 'duplicate' }, { status: 409 })
    return dbErrorResponse(err, 'api/influencers/[slug]')
  }
}
