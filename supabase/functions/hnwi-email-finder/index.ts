// supabase/functions/hnwi-email-finder/index.ts
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CONNECTOR_OS_API_KEY = Deno.env.get('CONNECTOR_OS_API_KEY')!

const REST_HEADERS = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
}

async function supabaseRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: REST_HEADERS,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${text}`)
  }
  const ct = res.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? res.json() : null
}

function parseName(fullName: string): { firstName: string; lastName: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
  }
}

async function findEmail(firstName: string, lastName: string, domain: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.connector-os.com/api/email/v2/find', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONNECTOR_OS_API_KEY}`,
      },
      body: JSON.stringify({ firstName, lastName, domain }),
    })
    if (res.status === 200) {
      const data = await res.json() as { email?: string }
      return data.email ?? null
    }
    // 404 = not found, 503 = busy — both skipped
    return null
  } catch {
    return null
  }
}

interface ValidationRow {
  id: string
  row_data: Record<string, unknown> | null
}

async function processJob(jobId: string): Promise<void> {
  const startTime = Date.now()
  const CHUNK_LIMIT_MS = 110_000

  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { status: 'processing' })

  while (true) {
    // Fetch pending rows that still have an empty email
    const rows = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${jobId}&status=eq.pending&email=eq.&order=row_index.asc&limit=50&select=id,row_data`,
    )) as ValidationRow[]

    if (!rows || rows.length === 0) break

    for (const row of rows) {
      const data = row.row_data ?? {}

      // Extract name: HNWI records use person_name; RIA records may use contact_name or firm_name
      const fullName = String(
        data.person_name ?? data.contact_name ?? data.name ?? '',
      )
      const domain = String(
        data.domain ?? data.company_domain ?? data.website ?? '',
      )

      const { firstName, lastName } = parseName(fullName)

      if (!firstName || !domain) {
        await supabaseRequest('PATCH', `validation_rows?id=eq.${row.id}`, { status: 'skipped' })
        continue
      }

      const email = await findEmail(firstName, lastName, domain)

      if (email) {
        // Write email — status stays 'pending' so email-validator picks it up
        await supabaseRequest('PATCH', `validation_rows?id=eq.${row.id}`, { email })
      } else {
        await supabaseRequest('PATCH', `validation_rows?id=eq.${row.id}`, { status: 'skipped' })
      }

      if (Date.now() - startTime > CHUNK_LIMIT_MS) {
        // Re-invoke self to continue; next invocation resumes from remaining pending+empty-email rows
        fetch(`${SUPABASE_URL}/functions/v1/hnwi-email-finder`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ job_id: jobId }),
        }).catch(err => console.error('[hnwi-email-finder] Self re-invoke error:', err))
        return
      }
    }
  }

  // Count rows that got emails (still pending, now have email set)
  const foundRows = (await supabaseRequest(
    'GET',
    `validation_rows?job_id=eq.${jobId}&status=eq.pending&select=id`,
  )) as { id: string }[]
  const totalFound = foundRows.length

  // Update job total_rows to reflect only the rows that will be validated
  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, {
    total_rows: totalFound,
    processed_rows: 0,
    valid_count: 0,
    invalid_count: 0,
  })

  if (totalFound === 0) {
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, {
      status: 'completed',
    })
    return
  }

  // Fire email-validator to validate the found emails
  await fetch(`${SUPABASE_URL}/functions/v1/email-validator`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ job_id: jobId }),
  })
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  let jobId: string
  try {
    const body = await req.json() as { job_id?: string }
    if (!body.job_id) {
      return new Response(JSON.stringify({ error: 'job_id is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    jobId = body.job_id
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const asyncWork = processJob(jobId).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[hnwi-email-finder] Job ${jobId} failed:`, message)
    try {
      await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, {
        status: 'failed',
        error_message: message,
      })
    } catch (patchErr) {
      console.error('[hnwi-email-finder] Failed to patch job to failed:', patchErr)
    }
  })

  EdgeRuntime.waitUntil(asyncWork)

  return new Response(JSON.stringify({ ok: true, job_id: jobId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
