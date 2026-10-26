import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { isApifyConfigured } from '@/lib/adapters/apify'
import { apifyErrorResponse } from '@/lib/apify/http'
import { ACTOR_ID_RE, briefView, loadActor } from '@/lib/apify/service'

/**
 * `GET /api/apify/actor?id=<username/name>` — the actor, its pricing (and
 * whether a run can be capped at $20) and its input fields, required first.
 * What the agent shows the owner before asking for inputs. Read-only.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  if (!isApifyConfigured()) return NextResponse.json({ error: 'apify_not_configured' }, { status: 503 })
  const id = (new URL(req.url).searchParams.get('id') ?? '').trim()
  if (!ACTOR_ID_RE.test(id)) return NextResponse.json({ error: 'id must be username/actor-name' }, { status: 400 })
  try {
    return NextResponse.json(briefView(await loadActor(id)))
  } catch (err) {
    return apifyErrorResponse(err, 'api/apify/actor')
  }
}
