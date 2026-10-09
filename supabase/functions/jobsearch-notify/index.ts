// Supabase Edge Function: jobsearch-notify
// Gate 1 of the job search pipeline. The Monday scheduled task inserts a
// job_batches row and POSTs {batch_id} here; this sends the owner the
// "review the sheet, then tap" prompt. Re-posting the same batch edits the
// existing message instead of sending a second one.
//
// Helpers copied from telegram-inbox/index.ts — edge functions in this repo
// are self-contained.

import { sheetTabLink } from '../_shared/jobsearch/sheets.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID')!
const JOBSEARCH_SHEET_ID = Deno.env.get('JOBSEARCH_SHEET_ID') ?? '1wjvpjyX2g7UUkjgeOXRtPEb7-s4MQfmPOgikalpthcs'
const JOBS_FINAL_GID = 935519386

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
  telegram_message_id: number | null
}

// "Mon 12 Oct" from an ISO date. Parsed as UTC noon so the weekday is stable
// regardless of the runtime's zone.
export function formatBatchDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '')
}

function gateOneText(batch: JobBatch): string {
  const link = sheetTabLink(JOBSEARCH_SHEET_ID, JOBS_FINAL_GID)
  const n = batch.companies_added
  return (
    `🧭 Job scrape — ${formatBatchDate(batch.batch_date)}\n` +
    `${n} new GTM-engineer ${n === 1 ? 'company' : 'companies'} added to Jobs Final.\n` +
    `Review the sheet, mark rejects "Not a Right Fit", then tap.\n\n` +
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

async function notify(batchId: string): Promise<{ message_id: number | null; edited: boolean }> {
  const rows = (await supabaseRequest(
    'GET',
    `job_batches?id=eq.${batchId}&select=id,batch_date,status,companies_added,telegram_message_id&limit=1`,
  )) as JobBatch[]
  const batch = rows?.[0]
  if (!batch) throw new Error(`job batch ${batchId} not found`)

  const text = gateOneText(batch)
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
    return { message_id: batch.telegram_message_id, edited: true }
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
    await supabaseRequest('PATCH', `job_batches?id=eq.${batchId}`, { telegram_message_id: messageId })
  }
  return { message_id: messageId, edited: false }
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
