import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner, requireOwnerSession } from '@/lib/auth/guards'
import { BANK_THRESHOLD_MAX, getBankThreshold, setBankThreshold } from '@/lib/settings/store'

/** `GET /api/settings/bank-threshold` — pushes with more eligible leads than this go to the lead bank. */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  return NextResponse.json({ threshold: await getBankThreshold(), max: BANK_THRESHOLD_MAX })
}

const Body = z.object({ threshold: z.number().int().min(1).max(BANK_THRESHOLD_MAX) }).strict()

/** `PUT /api/settings/bank-threshold` — owner's own session only (never the agent). */
export async function PUT(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_threshold', max: BANK_THRESHOLD_MAX }, { status: 400 })
  try {
    return NextResponse.json({ threshold: await setBankThreshold(parsed.data.threshold) })
  } catch {
    return NextResponse.json({ error: 'db_error' }, { status: 500 })
  }
}
