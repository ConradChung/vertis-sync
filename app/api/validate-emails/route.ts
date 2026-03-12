import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const maxDuration = 300

const MAILTESTER_API_KEY = process.env.MAILTESTER_API_KEY!
const MAILTESTER_BASE_URL = 'https://happy.mailtester.ninja/ninja'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!

async function sendTelegram(text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
      cache: 'no-store',
    })
  } catch {
    // Don't fail validation if Telegram is unreachable
  }
}

const TIER1_NAMES = new Set(['email', 'work_email', 'business_email'])
const PERSONAL_SUBSTRINGS = ['personal']

function normalizeHeader(h: string): string {
  return h.toLowerCase().trim().replace(/\s+/g, '_')
}

function detectEmailColumn(headers: string[]): { column: string } | { ambiguous: string[] } | { error: string } {
  const normalized = headers.map(normalizeHeader)
  const tier1: string[] = []
  const tier3: string[] = []

  for (let i = 0; i < headers.length; i++) {
    const norm = normalized[i]
    const isPersonal = PERSONAL_SUBSTRINGS.some(p => norm.includes(p))
    if (TIER1_NAMES.has(norm)) {
      tier1.push(headers[i])
    } else if (!isPersonal && (norm.includes('email') || norm.includes('mail'))) {
      tier3.push(headers[i])
    }
  }

  if (tier1.length === 1) return { column: tier1[0] }
  if (tier1.length > 1) return { ambiguous: tier1 }
  if (tier3.length === 1) return { column: tier3[0] }
  if (tier3.length > 1) return { ambiguous: tier3 }
  return { error: 'No email column found in CSV' }
}

function parseCSVRow(row: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < row.length; i++) {
    const char = row[i]
    if (char === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += char
    }
  }
  result.push(current)
  return result
}

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/)
  const nonEmpty = lines.filter(l => l.trim() !== '')
  if (nonEmpty.length === 0) return { headers: [], rows: [] }
  return { headers: parseCSVRow(nonEmpty[0]), rows: nonEmpty.slice(1).map(parseCSVRow) }
}

function serializeCSVField(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n') || field.includes('\r')) {
    return `"${field.replace(/"/g, '""')}"`
  }
  return field
}

function serializeCSV(headers: string[], rows: string[][]): string {
  const lines = [headers.map(serializeCSVField).join(',')]
  for (const row of rows) lines.push(row.map(serializeCSVField).join(','))
  return lines.join('\r\n')
}

type ValidationStatus = 'valid' | 'invalid' | 'unknown'

async function validateEmail(email: string): Promise<{ status: ValidationStatus; debug: string }> {
  try {
    const url = `${MAILTESTER_BASE_URL}?email=${encodeURIComponent(email)}&key=${encodeURIComponent(MAILTESTER_API_KEY)}`
    const res = await fetch(url, { cache: 'no-store' })
    const body = await res.text()
    console.log(`[validate-emails] ${email} → HTTP ${res.status}: ${body}`)
    if (!res.ok) return { status: 'unknown', debug: `HTTP ${res.status}: ${body}` }
    const data = JSON.parse(body)
    if (data.code === 'ok') return { status: 'valid', debug: data.code }
    if (data.code === 'ko') return { status: 'invalid', debug: data.code }
    return { status: 'unknown', debug: `code=${data.code} message=${data.message}` }
  } catch (e: any) {
    console.log(`[validate-emails] ${email} → error: ${e.message}`)
    return { status: 'unknown', debug: e.message }
  }
}

function sseEvent(data: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const columnOverride = formData.get('column') as string | null

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    const text = await file.text()
    const { headers, rows } = parseCSV(text)

    if (headers.length === 0) {
      return NextResponse.json({ error: 'CSV appears to be empty' }, { status: 400 })
    }

    let targetColumn: string
    if (columnOverride) {
      if (!headers.includes(columnOverride)) {
        return NextResponse.json({ error: `Column "${columnOverride}" not found in CSV` }, { status: 400 })
      }
      targetColumn = columnOverride
    } else {
      const detection = detectEmailColumn(headers)
      if ('error' in detection) {
        return NextResponse.json({ error: detection.error }, { status: 400 })
      }
      if ('ambiguous' in detection) {
        return NextResponse.json({ status: 'ambiguous', columns: detection.ambiguous })
      }
      targetColumn = detection.column
    }

    const colIndex = headers.indexOf(targetColumn)
    const total = rows.length
    console.log(`[validate-emails] key present=${!!MAILTESTER_API_KEY}, column="${targetColumn}", rows=${total}`)

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()

    const run = async () => {
      try {
        // 16 KB SSE comment to bust Vercel's response-buffer threshold so the
        // start event is flushed to the client immediately, even for large CSVs.
        const flush = new TextEncoder().encode(': ' + ' '.repeat(1024 * 16) + '\n\n')
        await writer.write(flush)
        await writer.write(sseEvent({ type: 'start', total }))

        const enrichedRows: string[][] = new Array(rows.length)
        let processed = 0
        let lastMilestoneSent = 0

        // Process in parallel batches of 11 (rate limit: 11 per 10 s).
        // Each batch fires concurrently then we wait for all before the next.
        const BATCH = 11
        for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH) {
          const batchEnd = Math.min(batchStart + BATCH, rows.length)
          const batchPromises = []

          for (let i = batchStart; i < batchEnd; i++) {
            const email = rows[i][colIndex]?.trim() ?? ''
            batchPromises.push(
              (email ? validateEmail(email) : Promise.resolve({ status: 'unknown' as ValidationStatus, debug: 'empty' }))
                .then(async result => {
                  enrichedRows[i] = [...rows[i], result.status]
                  processed++
                  await writer.write(sseEvent({ type: 'progress', processed, total, email, status: result.status, debug: result.debug }))
                })
            )
          }

          await Promise.all(batchPromises)

          // Respect rate limit: 11 per 10 s → wait before next batch
          if (batchEnd < rows.length) {
            await new Promise(r => setTimeout(r, 10_000))
          }

          const pct = Math.floor((processed / total) * 100)
          const milestone = Math.floor(pct / 10) * 10
          if (milestone > lastMilestoneSent && milestone < 100) {
            lastMilestoneSent = milestone
            await sendTelegram(`${milestone}% completion`)
          }
        }

        const validRows = enrichedRows.filter(r => r[r.length - 1] === 'valid')
        const validCount = validRows.length
        const outputRows = validRows.map(r => r.slice(0, -1))
        const csv = serializeCSV(headers, outputRows)

        const runId = crypto.randomUUID()
        const storagePath = `${runId}.csv`

        await Promise.allSettled([
          supabase.storage.from('validation-results').upload(storagePath, new Blob([csv], { type: 'text/csv' }), { contentType: 'text/csv' }),
          supabase.from('email_validation_runs').insert({ id: runId, file_name: file.name, total, valid_count: validCount, storage_path: storagePath }),
        ])

        await writer.write(sseEvent({ type: 'complete', csv, runId }))
        await sendTelegram(`100% complete — ${total} emails validated`)
      } catch (e) {
        await writer.write(sseEvent({ type: 'error', message: String(e) }))
      } finally {
        await writer.close()
      }
    }

    run()

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
