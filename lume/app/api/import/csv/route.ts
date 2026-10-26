import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { findIngestByStoragePath } from '@/lib/db/service'
import { parseJsonBody } from '@/lib/http/json'
import { MAX_CSV_BYTES, sniffCsvHeader } from '@/lib/import/csv'
import { ingestBody, intakeErrorResponse } from '@/lib/import/errors'
import { createIngestForStoredObject } from '@/lib/import/ingest'
import { removeObject, scanObject, statObject } from '@/lib/import/storage'
import { LUME_UPLOAD_PATH, verifyUploadTicket } from '@/lib/import/ticket'

/**
 * Step 2 of a CSV upload: the browser has put the file at the signed path
 * (`/api/import/csv/sign`). Checks, in order:
 *  - path is `lume/<uuid>.csv` and the ticket is its HMAC (constant-time) → 400 / 403;
 *  - no ingest already points at it → 409;
 *  - the object exists (404) and is ≤ 20 MB (413, from a HEAD, then enforced
 *    again while streaming);
 *  - the header reads as CSV and there is at least one data row → 400.
 * Then `createIngestForStoredObject` — the same approval prompt as Telegram.
 * A verified upload rejected by the size/CSV checks, or whose ingest row
 * cannot be written, is removed from Storage (best effort).
 */

// The streamed scan alone may take up to 60 s.
export const maxDuration = 90

const Body = z.object({
  storage_path: z.string().max(64),
  filename: z.string().trim().min(1).max(255),
  upload_ticket: z.string().max(128),
})

async function reject(path: string, error: string, status: number) {
  await removeObject(path)
  return NextResponse.json({ error }, { status })
}

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  const body = await parseJsonBody(req, Body, 2048)
  if (!body.ok) return body.response
  const { storage_path: path, upload_ticket } = body.data
  const filename = body.data.filename.split(/[\\/]/).pop()!.slice(0, 200)

  if (!LUME_UPLOAD_PATH.test(path)) return NextResponse.json({ error: 'invalid_path' }, { status: 400 })
  if (!filename.toLowerCase().endsWith('.csv')) return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  if (!verifyUploadTicket(path, upload_ticket)) return NextResponse.json({ error: 'invalid_ticket' }, { status: 403 })

  try {
    if (await findIngestByStoragePath(path)) return NextResponse.json({ error: 'already_ingested' }, { status: 409 })

    const stat = await statObject(path)
    if (!stat) return NextResponse.json({ error: 'upload_missing' }, { status: 404 })
    if (stat.size > MAX_CSV_BYTES) return reject(path, 'too_large', 413)

    const scan = await scanObject(path, MAX_CSV_BYTES)
    if (scan === undefined) return NextResponse.json({ error: 'upload_missing' }, { status: 404 })
    if (scan === null) return reject(path, 'too_large', 413)
    if (!sniffCsvHeader(scan.head)) return reject(path, 'not_csv', 400)
    if (scan.rows === 0) return reject(path, 'empty_csv', 400)

    let result
    try {
      result = await createIngestForStoredObject(path, filename, scan.head, scan.rows, { source: 'csv' })
    } catch (err) {
      // Only the ingest insert throws; no row points at the object, so drop
      // it — unless a duplicate key says another ingest now owns this path.
      if ((err as { code?: unknown } | null)?.code !== '23505') await removeObject(path)
      throw err
    }
    return NextResponse.json(ingestBody(result))
  } catch (err) {
    return intakeErrorResponse(err, 'api/import/csv')
  }
}
