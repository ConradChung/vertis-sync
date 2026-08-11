import { NextRequest, NextResponse } from 'next/server'

// Dashboard-side trigger for the Instantly push.
//
// GET  ?job_id=...            -> preview (counts + first 10 normalized names)
// POST { job_id, campaign_id, campaign_name, barriers } -> start the push
//
// Both delegate to the instantly-push edge function so the dashboard and the
// Telegram flow run the exact same code. Nothing about eligibility, name
// normalization, or the push itself is reimplemented here — this route only
// records the chosen campaign and barriers, then hands off.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

function restHeaders(): Record<string, string> {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  }
}

async function callEdgeFunction(body: unknown): Promise<Response> {
  return fetch(`${SUPABASE_URL}/functions/v1/instantly-push`, {
    method: 'POST',
    headers: restHeaders(),
    body: JSON.stringify(body),
  })
}

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get('job_id')
  if (!jobId) {
    return NextResponse.json({ error: 'job_id is required' }, { status: 400 })
  }

  try {
    const res = await callEdgeFunction({ job_id: jobId, mode: 'preview' })
    const data = await res.json()
    return NextResponse.json(data, { status: res.ok ? 200 : 502 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

// Save barrier settings without starting anything. The preview reads these
// from the job row, so the dashboard persists a toggle first and then re-reads
// the preview — same source of truth as the Telegram screens, which means the
// names shown here are the names that get pushed.
export async function PATCH(request: NextRequest) {
  let body: {
    job_id?: string
    location_barrier?: boolean
    company_barrier?: boolean
    company_strict?: boolean
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body.job_id) return NextResponse.json({ error: 'job_id is required' }, { status: 400 })

  const patch: Record<string, boolean> = {}
  if (body.location_barrier !== undefined) patch.location_barrier = body.location_barrier
  if (body.company_barrier !== undefined) patch.company_barrier = body.company_barrier
  if (body.company_strict !== undefined) patch.company_strict = body.company_strict
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No barrier fields supplied' }, { status: 400 })
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/validation_jobs?id=eq.${body.job_id}`, {
      method: 'PATCH',
      headers: { ...restHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: `Could not save barriers: ${text.slice(0, 200)}` }, { status: 502 })
    }
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  let body: {
    job_id?: string
    campaign_id?: string
    campaign_name?: string
    location_barrier?: boolean
    company_barrier?: boolean
    company_strict?: boolean
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { job_id, campaign_id, campaign_name } = body
  if (!job_id) return NextResponse.json({ error: 'job_id is required' }, { status: 400 })
  if (!campaign_id) return NextResponse.json({ error: 'campaign_id is required' }, { status: 400 })

  try {
    // Refuse to start a second push for a job that is already mid-flight or
    // finished — the row-level instantly_status makes a re-run resumable
    // rather than duplicative, but a double-click should still not queue two.
    const jobRes = await fetch(
      `${SUPABASE_URL}/rest/v1/validation_jobs?id=eq.${job_id}&select=id,status,instantly_status`,
      { headers: restHeaders(), cache: 'no-store' },
    )
    if (!jobRes.ok) {
      return NextResponse.json({ error: 'Could not load job' }, { status: 502 })
    }
    const jobs = (await jobRes.json()) as { id: string; status: string; instantly_status: string }[]
    const job = jobs[0]
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    if (job.status !== 'completed') {
      return NextResponse.json({ error: 'Job has not finished validating yet' }, { status: 409 })
    }
    if (job.instantly_status === 'pushing') {
      return NextResponse.json({ error: 'A push is already running for this job' }, { status: 409 })
    }

    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/validation_jobs?id=eq.${job_id}`, {
      method: 'PATCH',
      headers: { ...restHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        instantly_campaign_id: campaign_id,
        instantly_campaign_name: campaign_name ?? null,
        instantly_campaign_candidates: null,
        // Barriers keep their DB defaults (location off, company on) unless
        // the dashboard explicitly sends a value.
        ...(body.location_barrier !== undefined ? { location_barrier: body.location_barrier } : {}),
        ...(body.company_barrier !== undefined ? { company_barrier: body.company_barrier } : {}),
        ...(body.company_strict !== undefined ? { company_strict: body.company_strict } : {}),
        instantly_status: 'pushing',
      }),
    })
    if (!patchRes.ok) {
      const text = await patchRes.text()
      return NextResponse.json({ error: `Could not save push settings: ${text.slice(0, 200)}` }, { status: 502 })
    }

    // Fire-and-forget: the edge function responds immediately and keeps
    // working via EdgeRuntime.waitUntil, reporting to Telegram when done.
    const runRes = await callEdgeFunction({ job_id })
    if (!runRes.ok) {
      const text = await runRes.text()
      await fetch(`${SUPABASE_URL}/rest/v1/validation_jobs?id=eq.${job_id}`, {
        method: 'PATCH',
        headers: { ...restHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify({ instantly_status: 'error' }),
      })
      return NextResponse.json({ error: `Could not start push: ${text.slice(0, 200)}` }, { status: 502 })
    }

    return NextResponse.json({ ok: true, job_id, campaign_id })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
