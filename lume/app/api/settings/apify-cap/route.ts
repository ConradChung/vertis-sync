import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner, requireOwnerSession } from '@/lib/auth/guards'
import { apifyMonthSpend } from '@/lib/influencers/store'
import { APIFY_CAP_MAX_USD, getApifyCapUsd, setApifyCapUsd } from '@/lib/settings/store'

/** `GET /api/settings/apify-cap` — the shared monthly Apify cap and this month's ledger spend. */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const [cap, spend] = await Promise.all([getApifyCapUsd(), apifyMonthSpend().catch(() => null)])
  return NextResponse.json({ cap_usd: cap, month_to_date_usd: spend, max_usd: APIFY_CAP_MAX_USD })
}

const Body = z.object({ cap_usd: z.number().positive().max(APIFY_CAP_MAX_USD) }).strict()

/** `PUT /api/settings/apify-cap` — owner's own session only (never the agent). */
export async function PUT(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_cap', max_usd: APIFY_CAP_MAX_USD }, { status: 400 })
  try {
    const cap = await setApifyCapUsd(Math.round(parsed.data.cap_usd * 100) / 100)
    return NextResponse.json({ cap_usd: cap })
  } catch {
    return NextResponse.json({ error: 'db_error' }, { status: 500 })
  }
}
