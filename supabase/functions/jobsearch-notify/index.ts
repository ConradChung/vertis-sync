// Supabase Edge Function: jobsearch-notify
// Gate 1 of the job search pipeline. The Monday scheduled task inserts a
// job_batches row and POSTs {batch_id} here; this sends the owner the
// "review the sheet, then tap" prompt. Re-posting the same batch edits the
// existing message instead of sending a second one.
//
// Helpers copied from telegram-inbox/index.ts — edge functions in this repo
// are self-contained.

import { normalizeCompanyName, normalizeDomain, optionalHeaderIndex } from '../_shared/jobsearch/pure.ts'
import { classifyPool, companiesNeeded, LEADSFRIDAY_MIN_CONTACTS, type Pool } from '../_shared/jobsearch/pool.ts'
import { getAccessToken, readRange, sheetTabLink } from '../_shared/jobsearch/sheets.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID')!
const JOBSEARCH_SHEET_ID = Deno.env.get('JOBSEARCH_SHEET_ID') ?? '1wjvpjyX2g7UUkjgeOXRtPEb7-s4MQfmPOgikalpthcs'
const GOOGLE_SERVICE_ACCOUNT_JSON = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON') ?? ''
const JOBS_FINAL_GID = 935519386
// Statuses whose companies are spoken for (mirrors the puller).
const LIVE_STATUSES = 'approved,resolving,waiting_fill,ordered,delivered,ranked,written'

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`

const REST_HEADERS: Record<string, string> = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
}

async function supabaseRequest(
  method: string,
  path: string,
  body?: unknown,
  opts?: { returning?: boolean },
): Promise<unknown> {
  const headers = { ...REST_HEADERS }
  if (opts?.returning) headers['Prefer'] = 'return=representation'
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
  if (ct.includes('application/json')) return res.json()
  return null
}

async function tg(method: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

interface JobBatch {
  id: string
  batch_date: string
  status: string
  companies_added: number
  lookback_days: number
  telegram_message_id: number | null
}

function invokeBatchFunction(name: string, body: Record<string, unknown>): void {
  fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(err => console.error(`[jobsearch-notify] ${name} invoke error:`, err))
}

// Pool summary for the prompt. Best effort: a Sheets failure here must not
// stop the gate message, so it returns null and the text omits the line.
async function poolSummary(batch: JobBatch): Promise<Pool | null> {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) return null
  try {
    const token = await getAccessToken(GOOGLE_SERVICE_ACCOUNT_JSON)
    const grid = await readRange(token, JOBSEARCH_SHEET_ID, "'Jobs Final'!A1:ZZ")
    if (grid.length < 2) return null
    const gtm = await readRange(token, JOBSEARCH_SHEET_ID, 'gtm!A1:ZZ')
    const gtmNames = new Set<string>()
    const gtmDomains = new Set<string>()
    if (gtm.length > 1) {
      const gCompany = optionalHeaderIndex(gtm[0], 'company')
      const gDomain = optionalHeaderIndex(gtm[0], 'domain')
      for (const r of gtm.slice(1)) {
        if (gCompany >= 0 && r[gCompany]) gtmNames.add(normalizeCompanyName(r[gCompany]))
        if (gDomain >= 0 && r[gDomain]) { const d = normalizeDomain(r[gDomain]); if (d) gtmDomains.add(d) }
      }
    }
    const taken = (await supabaseRequest(
      'GET',
      `job_batch_companies?select=domain,company_name,job_batches!inner(status)&job_batches.status=in.(${LIVE_STATUSES})&resolve_status=in.(pending,resolved)&limit=5000`,
    )) as { domain: string | null; company_name: string }[]
    const takenDomains = new Set<string>()
    const takenNames = new Set<string>()
    for (const t of taken ?? []) {
      if (t.domain) takenDomains.add(t.domain)
      const n = normalizeCompanyName(t.company_name)
      if (n) takenNames.add(n)
    }
    return classifyPool(grid[0], grid.slice(1), {
      batchDate: batch.batch_date, lookbackDays: batch.lookback_days ?? 365, gtmNames, gtmDomains, takenDomains, takenNames,
    })
  } catch (err) {
    console.warn('[jobsearch-notify] pool summary failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// "Mon 12 Oct" from an ISO date. Parsed as UTC noon so the weekday is stable
// regardless of the runtime's zone.
export function formatBatchDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '')
}

function gateOneText(batch: JobBatch, pool: Pool | null): string {
  const link = sheetTabLink(JOBSEARCH_SHEET_ID, JOBS_FINAL_GID)
  const n = batch.companies_added
  const need = companiesNeeded()
  const poolLine = pool
    ? `Eligible pool not yet in gtm (last ${batch.lookback_days ?? 365} days): ` +
      `${pool.byTier[1]} strict GTM · ${pool.byTier[2]} adjacent · ${pool.byTier[3]} other.\n`
    : ''
  return (
    `🧭 Job scrape — ${formatBatchDate(batch.batch_date)}\n` +
    `${n} new ${n === 1 ? 'company' : 'companies'} added to Jobs Final.\n` +
    poolLine +
    `Review the sheet, mark rejects "Not a Right Fit", then tap.\n\n` +
    `💳 Next order: ${LEADSFRIDAY_MIN_CONTACTS}+ Leadsfriday contacts (~${need}–60 companies, strict GTM titles first, then adjacent, then everything). ` +
    `Apollo lookups are free. An Abort button follows every step until the order is placed.\n\n` +
    link
  )
}

function gateOneKeyboard(batch: JobBatch) {
  return {
    inline_keyboard: [[
      { text: '✅ Reviewed, pull contacts', callback_data: `jobs_pull:${batch.id}` },
      { text: '⏭ Skip this week', callback_data: `jobs_skip:${batch.id}` },
    ]],
  }
}

const BATCH_SELECT = 'id,batch_date,status,companies_added,lookback_days,telegram_message_id'

// A new scrape while a batch is still open folds into that batch instead of
// competing with it: the pool is shared, so two open batches would race for
// the same companies. awaiting_review -> the open prompt's count grows;
// waiting_fill -> the parked batch gets refilled right away.
async function mergeIntoOpen(batch: JobBatch): Promise<JobBatch | null> {
  const open = (await supabaseRequest(
    'GET',
    `job_batches?status=in.(awaiting_review,waiting_fill)&id=neq.${batch.id}&select=${BATCH_SELECT}&order=created_at.asc&limit=1`,
  )) as JobBatch[]
  const target = open?.[0]
  if (!target) return null

  const merged = (await supabaseRequest(
    'PATCH',
    `job_batches?id=eq.${batch.id}&status=eq.awaiting_review`,
    { status: 'merged', merged_into: target.id, review_status: 'claimed' },
    { returning: true },
  )) as JobBatch[]
  if (!merged?.length) return null

  const updated = (await supabaseRequest(
    'PATCH', `job_batches?id=eq.${target.id}`,
    { companies_added: (target.companies_added ?? 0) + (batch.companies_added ?? 0) },
    { returning: true },
  )) as JobBatch[]
  const t = updated?.[0] ?? target

  if (t.status === 'waiting_fill') {
    await tg('sendMessage', {
      chat_id: TELEGRAM_CHAT_ID,
      text: `➕ ${batch.companies_added} new ${batch.companies_added === 1 ? 'company' : 'companies'} from the ${formatBatchDate(batch.batch_date)} scrape ` +
        `added to the open batch of ${formatBatchDate(t.batch_date)} — refilling now.`,
    })
    invokeBatchFunction('jobsearch-puller', { batch_id: t.id, phase: 'refill' })
  }
  return t
}

async function notify(batchId: string): Promise<{ message_id: number | null; edited: boolean; merged_into?: string }> {
  const rows = (await supabaseRequest(
    'GET', `job_batches?id=eq.${batchId}&select=${BATCH_SELECT}&limit=1`,
  )) as JobBatch[]
  let batch = rows?.[0]
  if (!batch) throw new Error(`job batch ${batchId} not found`)

  let mergedInto: string | undefined
  if (batch.status === 'awaiting_review' && !batch.telegram_message_id) {
    const target = await mergeIntoOpen(batch)
    if (target) {
      mergedInto = target.id
      if (target.status !== 'awaiting_review') return { message_id: null, edited: false, merged_into: mergedInto }
      batch = target // fall through: refresh the open prompt with the new count
    }
  }

  const pool = batch.status === 'awaiting_review' ? await poolSummary(batch) : null
  const text = gateOneText(batch, pool)
  // Buttons only while the gate is open. A late retry after the owner has
  // already tapped must not re-arm a decided batch.
  const reply_markup = batch.status === 'awaiting_review' ? gateOneKeyboard(batch) : undefined

  if (batch.telegram_message_id) {
    const res = await tg('editMessageText', {
      chat_id: TELEGRAM_CHAT_ID,
      message_id: batch.telegram_message_id,
      text,
      reply_markup,
      disable_web_page_preview: true,
    })
    // "message is not modified" is Telegram's way of saying the edit was a no-op.
    if (!res.ok && !String(res.description ?? '').includes('not modified')) {
      throw new Error(`Telegram editMessageText failed: ${res.description}`)
    }
    return { message_id: batch.telegram_message_id, edited: true, merged_into: mergedInto }
  }

  const res = await tg('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    reply_markup,
    disable_web_page_preview: true,
  })
  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.description}`)
  const messageId = (res.result as { message_id?: number } | undefined)?.message_id ?? null
  if (messageId) {
    await supabaseRequest('PATCH', `job_batches?id=eq.${batch.id}`, { telegram_message_id: messageId })
  }
  return { message_id: messageId, edited: false, merged_into: mergedInto }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let batchId: string | undefined
  try {
    const body = await req.json() as { batch_id?: string }
    batchId = body.batch_id
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  if (!batchId) {
    return new Response(JSON.stringify({ error: 'batch_id is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const result = await notify(batchId)
    return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[jobsearch-notify]', message)
    const status = message.includes('not found') ? 404 : 500
    return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: { 'Content-Type': 'application/json' } })
  }
})
