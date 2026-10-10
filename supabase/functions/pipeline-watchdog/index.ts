// Stall watchdog — NOTIFIES, never revives.
//
// The previous version was a pg_cron function that re-invoked workers by
// itself. That went wrong twice: it revived an abandoned April job and spent
// MailTester credits on a list nobody was waiting for, and its "same done-count
// across two ticks" test could not distinguish a stalled job from a slow one.
//
// Detection lives here rather than in SQL so the Telegram token stays an edge
// function secret instead of being copied into the database vault. pg_cron's
// only job is to POST to this function every 5 minutes.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

const REST_HEADERS: Record<string, string> = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
}

const STALL_MINUTES = 10
const RENOTIFY_HOURS = 1
const ABANDONED_HOURS = 24

async function supabaseRequest(
  method: string,
  path: string,
  body?: unknown,
  opts?: { returning?: boolean },
): Promise<unknown> {
  const headers = opts?.returning
    ? { ...REST_HEADERS, 'Prefer': 'return=representation' }
    : REST_HEADERS
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${text}`)
  }
  const ct = res.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? res.json() : null
}

interface Job {
  id: string
  filename: string
  total_rows: number
  processed_rows: number
  status: string
  created_at: string
  updated_at: string
}

async function checkForStalls(): Promise<{ scanned: number; notified: string[] }> {
  const nowMs = Date.now()
  const abandonedCutoff = new Date(nowMs - ABANDONED_HOURS * 3600_000).toISOString()
  const renotifyCutoff = new Date(nowMs - RENOTIFY_HOURS * 3600_000).toISOString()

  // Candidates only. Every exclusion here is a case where silence is correct:
  //   status in (pending, processing) — cancelled/failed/completed are not stalls
  //   finder_status <> awaiting_decision — parked on the owner's answer, by design
  //   created_at > 24h ago — abandoned, not stalled; do not resurrect
  //   watchdog_status = idle — a prompt is not already live
  //   watchdog_notified_at — at most one notification per job per hour
  const jobs = (await supabaseRequest(
    'GET',
    `validation_jobs?status=in.(pending,processing)` +
    `&finder_status=neq.awaiting_decision` +
    `&created_at=gt.${abandonedCutoff}` +
    `&watchdog_status=eq.idle` +
    `&or=(watchdog_notified_at.is.null,watchdog_notified_at.lt.${renotifyCutoff})` +
    `&select=id,filename,total_rows,processed_rows,status,created_at,updated_at` +
    // Explicit bound. PostgREST caps an unbounded GET at 1000 silently, so
    // every multi-row read here states its own limit.
    `&limit=200`,
  )) as Job[]

  const notified: string[] = []

  for (const job of jobs ?? []) {
    // The stall test: no heartbeat in STALL_MINUTES.
    //
    // validation_jobs.updated_at is the ONLY stage-agnostic heartbeat. Using
    // validation_rows.processed_at was wrong: the enricher never writes that
    // column, so a healthy 4-hour enrichment looked stalled from the first
    // tick — and tapping Resume would have started a SECOND enricher on a
    // per-row-billed function. All three workers PATCH the job row on every
    // row (processed_rows / emails_found / enriched_rows), so updated_at moves
    // no matter which stage is live.
    const latestRow = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${job.id}&processed_at=not.is.null` +
      `&order=processed_at.desc&limit=1&select=processed_at`,
    )) as { processed_at: string }[]

    const beats = [job.updated_at, latestRow?.[0]?.processed_at, job.created_at]
      .filter(Boolean)
      .map(t => new Date(t as string).getTime())
    const lastActivity = Math.max(...beats)
    const idleMinutes = (nowMs - lastActivity) / 60_000
    if (idleMinutes < STALL_MINUTES) continue

    // Claim the notification slot before sending. Two overlapping ticks then
    // cannot produce two prompts for the same job.
    const claimed = (await supabaseRequest(
      'PATCH',
      `validation_jobs?id=eq.${job.id}&watchdog_status=eq.idle`,
      { watchdog_status: 'awaiting', watchdog_notified_at: new Date().toISOString() },
      { returning: true },
    )) as Job[]
    if (!claimed || claimed.length === 0) continue

    // Use the job's own counters, NOT a row query. Counting rows here was
    // wrong twice over: an unbounded PostgREST GET silently caps at 1000, so a
    // job 3,328 rows in reported "1000/5385"; and status<>'pending' also
    // counts no_email rows, which are not part of total_rows. processed_rows
    // is what the validator itself increments, so this number now matches the
    // 10% milestone messages exactly.
    const done = claimed[0].processed_rows ?? 0

    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text:
            `⚠️ Job ${job.filename} looks stalled at ${done}/${job.total_rows}\n` +
            `No rows written in ${Math.floor(idleMinutes)} minutes.\n\nResume?`,
          reply_markup: {
            inline_keyboard: [[
              { text: '▶️ Resume', callback_data: `wd_resume:${job.id}` },
            ]],
          },
        }),
      })
    }
    notified.push(job.id)
  }

  return { scanned: jobs?.length ?? 0, notified }
}

// ---- Job search batches ----
//
// Same contract as above, for job_batches: notify, never revive. The puller
// PATCHes the batch row as it works (and once a minute while polling
// Leadsfriday), so updated_at is the heartbeat. 15 minutes rather than 10
// because a resolve or rank invocation can legitimately run close to the
// 110 s budget several times in a row before touching the row.

const JOB_STALL_MINUTES = 15
const JOB_WORKING_STATUSES = 'approved,resolving,ordered,delivered'

interface JobBatch {
  id: string
  batch_date: string
  status: string
  updated_at: string
}

function formatBatchDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

async function checkJobBatchStalls(): Promise<{ scanned: number; notified: string[] }> {
  const nowMs = Date.now()
  const stallCutoff = new Date(nowMs - JOB_STALL_MINUTES * 60_000).toISOString()
  const renotifyCutoff = new Date(nowMs - RENOTIFY_HOURS * 3600_000).toISOString()

  const batches = (await supabaseRequest(
    'GET',
    `job_batches?status=in.(${JOB_WORKING_STATUSES})` +
    `&watchdog_status=eq.idle` +
    `&updated_at=lt.${stallCutoff}` +
    `&or=(watchdog_notified_at.is.null,watchdog_notified_at.lt.${renotifyCutoff})` +
    `&select=id,batch_date,status,updated_at` +
    `&limit=50`,
  )) as JobBatch[]

  const notified: string[] = []
  for (const batch of batches ?? []) {
    const idleMinutes = Math.floor((nowMs - new Date(batch.updated_at).getTime()) / 60_000)

    // Claim the slot before sending so two overlapping ticks cannot produce
    // two prompts. (The claim itself bumps updated_at through the trigger;
    // the next tick is gated by watchdog_status, not by the heartbeat.)
    const claimed = (await supabaseRequest(
      'PATCH',
      `job_batches?id=eq.${batch.id}&watchdog_status=eq.idle`,
      { watchdog_status: 'awaiting', watchdog_notified_at: new Date().toISOString() },
      { returning: true },
    )) as JobBatch[]
    if (!claimed || claimed.length === 0) continue

    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text:
            `⚠️ Job batch ${formatBatchDate(batch.batch_date)} stalled at ${batch.status}\n` +
            `No heartbeat in ${idleMinutes} minutes.\n\nResume?`,
          reply_markup: {
            inline_keyboard: [[
              { text: '▶️ Resume', callback_data: `jobs_resume:${batch.id}` },
              { text: '⛔ Abort', callback_data: `jobs_abort:${batch.id}` },
            ]],
          },
        }),
      })
    }
    notified.push(batch.id)
  }

  return { scanned: batches?.length ?? 0, notified }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  try {
    const result = await checkForStalls()
    // The job search scan runs after and independently: a failure there is
    // reported but never hides the validation result.
    let job_batches: { scanned: number; notified: string[] } | { error: string }
    try {
      job_batches = await checkJobBatchStalls()
    } catch (err: unknown) {
      job_batches = { error: err instanceof Error ? err.message : String(err) }
      console.error('[pipeline-watchdog] job_batches scan failed:', job_batches.error)
    }
    return new Response(JSON.stringify({ ok: true, ...result, job_batches }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[pipeline-watchdog]', message)
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
