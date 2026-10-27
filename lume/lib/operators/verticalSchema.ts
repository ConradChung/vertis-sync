import { NextResponse } from 'next/server'
import { z } from 'zod'
import { DefaultVerticalConflictError, DuplicateVerticalNameError } from '@/lib/operators/store'
import { VERTICAL_SCOPES } from '@/lib/operators/types'

/** Field schemas shared by the vertical routes (and the agent's vertical tools mirror them). */
export const CAMPAIGN_ID = z.string().trim().regex(/^[A-Za-z0-9_:-]{1,80}$/)
export const VerticalFields = {
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(VERTICAL_SCOPES)).max(VERTICAL_SCOPES.length),
  campaign_ids: z.array(CAMPAIGN_ID).max(50),
  is_default: z.boolean(),
}

/** Store conflicts → 409; anything else null (the caller's DB error path). */
export function verticalConflict(err: unknown): NextResponse | null {
  if (err instanceof DuplicateVerticalNameError) return NextResponse.json({ error: 'duplicate_name' }, { status: 409 })
  if (err instanceof DefaultVerticalConflictError) return NextResponse.json({ error: 'default_taken' }, { status: 409 })
  return null
}
