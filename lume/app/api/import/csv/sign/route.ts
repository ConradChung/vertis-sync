import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { parseJsonBody } from '@/lib/http/json'
import { MAX_CSV_BYTES } from '@/lib/import/csv'
import { intakeErrorResponse } from '@/lib/import/errors'
import { createSignedUpload } from '@/lib/import/storage'
import { uploadTicket } from '@/lib/import/ticket'

/**
 * Step 1 of a CSV upload. Vercel caps function request bodies at ~4.5 MB, so
 * the browser uploads the file straight to Storage: this route checks the
 * declared name and size, picks the path (`lume/<uuid>.csv`), and returns a
 * one-time signed upload URL plus an `upload_ticket` (HMAC of the path) that
 * step 2 (`POST /api/import/csv`) requires.
 */

const Body = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
})

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  const body = await parseJsonBody(req, Body, 2048)
  if (!body.ok) return body.response
  if (!body.data.filename.toLowerCase().endsWith('.csv')) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  if (body.data.size > MAX_CSV_BYTES) return NextResponse.json({ error: 'too_large' }, { status: 413 })

  const path = `lume/${crypto.randomUUID()}.csv`
  try {
    const signed = await createSignedUpload(path)
    return NextResponse.json({ path, token: signed.token, signedUrl: signed.signedUrl, upload_ticket: uploadTicket(path) })
  } catch (err) {
    return intakeErrorResponse(err, 'api/import/csv/sign')
  }
}
