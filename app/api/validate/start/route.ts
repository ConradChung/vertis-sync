import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServerClient } from '@supabase/ssr'

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

function createServiceClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll: () => [],
        setAll: () => {},
      },
    }
  )
}

export async function POST(request: NextRequest) {
  try {
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
    const job_id = crypto.randomUUID()

    // Use service role client for inserts to bypass RLS
    const supabase = createServiceClient()

    // Insert validation_jobs row
    const { error: jobError } = await supabase
      .from('validation_jobs')
      .insert({
        id: job_id,
        filename: file.name,
        total_rows: rows.length,
        processed_rows: 0,
        valid_count: 0,
        invalid_count: 0,
        status: 'pending',
      })

    if (jobError) {
      return NextResponse.json({ error: `Failed to create job: ${jobError.message}` }, { status: 500 })
    }

    // Bulk insert validation_rows
    const validationRows = rows.map((row, i) => ({
      job_id,
      email: row[colIndex] ?? '',
      row_index: i,
      status: 'pending',
    }))

    const { error: rowsError } = await supabase
      .from('validation_rows')
      .insert(validationRows)

    if (rowsError) {
      return NextResponse.json({ error: `Failed to insert rows: ${rowsError.message}` }, { status: 500 })
    }

    // Fire-and-forget: invoke Edge Function
    fetch(
      'https://rcfrumrbauwvyzfebxck.supabase.co/functions/v1/email-validator',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ job_id }),
      }
    ).catch(err => console.error('[validate/start] Edge Function invoke error:', err))

    return NextResponse.json({ job_id, total: rows.length })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
