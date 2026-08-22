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

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  try {
    const result = await checkForStalls()
    return new Response(JSON.stringify({ ok: true, ...result }), {
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
