import { NextRequest, NextResponse } from 'next/server'

// Job search pipeline — the dashboard's copy of the Telegram buttons.
//
// POST { action: 'pull' | 'skip' | 'write' | 'discard' | 'resume' }
//
// Runs the SAME conditional PATCH telegram-inbox runs for the matching
// callback, then invokes the same edge function. A claim that returns zero rows
// means the other surface (or a double click) already handled it -> 409.
// Service-role REST, like /api/instantly/push.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

type Action = 'pull' | 'skip' | 'write' | 'discard' | 'resume'

const CLAIMS: Record<Action, { filter: string; patch: Record<string, unknown>; invoke?: string }> = {
  pull: {
    filter: 'review_status=eq.awaiting&status=eq.awaiting_review',
    patch: { review_status: 'claimed', status: 'approved' },
    invoke: 'jobsearch-puller',
  },
  skip: {
    filter: 'review_status=eq.awaiting&status=eq.awaiting_review',
    patch: { review_status: 'claimed', status: 'skipped' },
  },
  write: {
    filter: 'write_status=eq.awaiting&status=eq.ranked',
    patch: { write_status: 'claimed' },
    invoke: 'jobsearch-sheet-writer',
  },
  discard: {
    filter: 'write_status=eq.awaiting&status=eq.ranked',
    patch: { write_status: 'claimed', status: 'discarded' },
  },
  resume: {
    filter: 'watchdog_status=eq.awaiting',
    patch: { watchdog_status: 'claimed' },
    invoke: 'jobsearch-puller',
  },
}

function restHeaders(prefer = 'return=representation'): Record<string, string> {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: prefer,
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid batch id' }, { status: 400 })
  }

  let action: Action
  try {
    const body = (await request.json()) as { action?: string }
    if (!body.action || !(body.action in CLAIMS)) {
      return NextResponse.json({ error: 'action must be one of pull, skip, write, discard, resume' }, { status: 400 })
    }
    action = body.action as Action
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const claim = CLAIMS[action]

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/job_batches?id=eq.${id}&${claim.filter}&select=id,batch_date,status`,
      { method: 'PATCH', headers: restHeaders(), body: JSON.stringify(claim.patch) },
    )
    if (!res.ok) {
      return NextResponse.json({ error: `claim failed (${res.status}): ${await res.text()}` }, { status: 500 })
    }
    const rows = (await res.json()) as { id: string; status: string }[]
    if (!rows.length) {
      return NextResponse.json({ error: 'already handled' }, { status: 409 })
    }

    if (action === 'resume') {
      // Same as telegram-inbox: back to idle so a later stall can notify again.
      await fetch(`${SUPABASE_URL}/rest/v1/job_batches?id=eq.${id}`, {
        method: 'PATCH',
        headers: restHeaders('return=minimal'),
        body: JSON.stringify({ watchdog_status: 'idle' }),
      })
    }

    if (claim.invoke) {
      const inv = await fetch(`${SUPABASE_URL}/functions/v1/${claim.invoke}`, {
        method: 'POST',
        headers: restHeaders(),
        body: JSON.stringify({ batch_id: id }),
      })
      if (!inv.ok) {
        return NextResponse.json(
          { ok: true, status: rows[0].status, warning: `${claim.invoke} returned ${inv.status}` },
          { status: 200 },
        )
      }
    }

    return NextResponse.json({ ok: true, status: rows[0].status })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
