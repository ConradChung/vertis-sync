import { NextResponse } from 'next/server'
import type { z } from 'zod'
import { readBodyCapped } from '@/lib/http/readBody'

/**
 * Read a small JSON body (byte-capped) and validate it with a zod schema.
 * Failure is a ready 400/413 response; detail stays out of the body.
 */
export async function parseJsonBody<T extends z.ZodType>(
  req: Request,
  schema: T,
  maxBytes = 8 * 1024
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  const body = await readBodyCapped(req, maxBytes)
  if (!body.ok) return { ok: false, response: NextResponse.json({ error: 'too_large' }, { status: 413 }) }
  let raw: unknown
  try {
    raw = JSON.parse(body.text)
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return { ok: false, response: NextResponse.json({ error: 'invalid_body' }, { status: 400 }) }
  return { ok: true, data: parsed.data }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Lowercased uuid, or `null` when `v` is not one. */
export function uuidParam(v: string | undefined): string | null {
  return v && UUID_RE.test(v) ? v.toLowerCase() : null
}
