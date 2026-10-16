import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { readBytesCapped } from '@/lib/http/readBody'
import { MAX_CSV_BYTES, countDataRows, sniffCsvHeader } from '@/lib/import/csv'
import { ingestBody, intakeErrorResponse } from '@/lib/import/errors'
import { createIngest } from '@/lib/import/ingest'

/**
 * Multipart CSV upload (field `file`, ≤ 20 MB, `.csv` only) into the
 * approval gate via `createIngest`. 415 for a non-multipart request or a
 * non-.csv name, 413 over the cap, 400 when the header does not read as CSV
 * or there are no data rows.
 */

export const maxDuration = 60

// Multipart framing around the file: boundaries, part headers.
const MULTIPART_OVERHEAD = 64 * 1024

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  const type = req.headers.get('content-type') ?? ''
  if (!type.toLowerCase().startsWith('multipart/form-data')) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }

  const body = await readBytesCapped(req, MAX_CSV_BYTES + MULTIPART_OVERHEAD)
  if (!body.ok) return NextResponse.json({ error: 'too_large' }, { status: 413 })

  let form: FormData
  try {
    form = await new Response(body.bytes as BodyInit, { headers: { 'content-type': type } }).formData()
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
  const file = form.get('file')
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'missing_file' }, { status: 400 })

  const name = (file.name || '').trim()
  if (!name.toLowerCase().endsWith('.csv')) return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  if (file.size > MAX_CSV_BYTES) return NextResponse.json({ error: 'too_large' }, { status: 413 })

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!sniffCsvHeader(bytes)) return NextResponse.json({ error: 'not_csv' }, { status: 400 })
  if (countDataRows(bytes) === 0) return NextResponse.json({ error: 'empty_csv' }, { status: 400 })

  // Keep the original name readable in the prompt, without path parts.
  const filename = name.split(/[\\/]/).pop()!.slice(0, 200)
  try {
    return NextResponse.json(ingestBody(await createIngest(bytes, filename, { source: 'csv' })))
  } catch (err) {
    return intakeErrorResponse(err, 'api/import/csv')
  }
}
