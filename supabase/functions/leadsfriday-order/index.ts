// Supabase Edge Function: leadsfriday-order
// Second intake for the CSV approval pipeline. The owner pastes an Apollo
// people-search URL into Telegram and picks a count (telegram-inbox), this
// function places the Leadsfriday order, waits for delivery, pulls the CSV and
// hands it to the existing pipeline as a telegram_ingests row with the same
// Approve / Approve + Enrich / Deny prompt a dropped file gets.
//
// POST {order_id, phase?}   phases: order (ordering -> ordered), poll (ordered
// -> delivered -> ingested). Without a phase it is derived from status, so a
// pasted Leadsfriday order id (status already 'ordered') starts at poll.
//
// Helpers copied from telegram-inbox; polling pattern from jobsearch-puller.

import { parseCsv } from '../_shared/jobsearch/pure.ts'
import { alert, type AlertInput, gateKey, lumeLink, titleFrom } from '../_shared/alert.ts'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''
const LEADSFRIDAY_API_TOKEN = Deno.env.get('LEADSFRIDAY_API_TOKEN') ?? ''
const LEADSFRIDAY_BASE = Deno.env.get('LEADSFRIDAY_BASE_URL') ?? 'https://api.leadsfriday.com'

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
const CHUNK_LIMIT_MS = 110_000
const POLL_SLEEP_MS = 60_000
const POLL_GIVE_UP_MS = 12 * 3600_000   // big exports take longer than the job search ones

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
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false }
  try {
    const res = await fetch(`${TG_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await res.json()
  } catch {
    return { ok: false }
  }
}

function sendTelegram(text: string, reply_markup?: unknown): Promise<Record<string, unknown>> {
  return tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text, reply_markup, disable_web_page_preview: true })
}

// Every notice lands in lume_alerts; Telegram sends exactly as before while
// ALERT_CHANNELS includes telegram (the default). Resolves to the Telegram
// response, or undefined when Telegram is switched off.
type NotifyMeta = Pick<AlertInput<unknown>, 'severity' | 'link' | 'campaign_id' | 'scope' | 'dedupe_key'>
function notify(text: string, meta: NotifyMeta, reply_markup?: unknown): Promise<Record<string, unknown> | undefined> {
  return alert({
    source: 'leadsfriday-order', title: titleFrom(text), body: text, scope: 'orders', ...meta,
    telegram: () => sendTelegram(text, reply_markup),
  })
}

// ---- Email column detection (mirrors telegram-inbox / app/api/validate/start) ----

const TIER1_NAMES = new Set(['email', 'work_email', 'business_email'])
const PERSONAL_SUBSTRINGS = ['personal']

function normalizeHeader(h: string): string {
  return h.toLowerCase().trim().replace(/\s+/g, '_')
}

function detectEmailColumn(headers: string[]): string | null {
  const tier1: string[] = []
  const tier3: string[] = []
  for (const h of headers) {
    const norm = normalizeHeader(h)
    const isPersonal = PERSONAL_SUBSTRINGS.some(p => norm.includes(p))
    if (TIER1_NAMES.has(norm)) tier1.push(h)
    else if (!isPersonal && (norm.includes('email') || norm.includes('mail'))) tier3.push(h)
  }
  if (tier1.length === 1) return tier1[0]
  if (tier1.length > 1) return null
  if (tier3.length === 1) return tier3[0]
  return null
}

// ---- Types ----------------------------------------------------------------

type Phase = 'order' | 'poll'

interface Payload {
  order_id: string
  phase?: Phase
  ordered_at?: string
}

interface ApolloOrder {
  id: string
  apollo_url: string | null
  contact_count: number | null
  status: string
  leadsfriday_order_id: number | null
  leadsfriday_status: string | null
  telegram_message_id: number | null
  created_at: string
  updated_at: string
}

const PHASE_FOR_STATUS: Record<string, Phase> = { ordering: 'order', ordered: 'poll' }
const STATUS_FOR_PHASE: Record<Phase, string> = { order: 'ordering', poll: 'ordered' }

// ---- Helpers --------------------------------------------------------------

function selfInvoke(payload: Payload): void {
  fetch(`${SUPABASE_URL}/functions/v1/leadsfriday-order`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(err => console.error('[leadsfriday-order] self-invoke error:', err))
}

async function loadOrder(id: string): Promise<ApolloOrder> {
  const rows = (await supabaseRequest(
    'GET',
    `apollo_orders?id=eq.${id}&select=id,apollo_url,contact_count,status,leadsfriday_order_id,leadsfriday_status,telegram_message_id,created_at,updated_at&limit=1`,
  )) as ApolloOrder[]
  if (!rows?.[0]) throw new Error(`apollo order ${id} not found`)
  return rows[0]
}

async function claimStatus(id: string, from: string, patch: Record<string, unknown>, extraFilter = ''): Promise<boolean> {
  const rows = (await supabaseRequest(
    'PATCH', `apollo_orders?id=eq.${id}&status=eq.${from}${extraFilter}`, patch, { returning: true },
  )) as unknown[]
  return Array.isArray(rows) && rows.length > 0
}

function heartbeat(id: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  return supabaseRequest('PATCH', `apollo_orders?id=eq.${id}`, { updated_at: new Date().toISOString(), ...extra })
}

async function stillInStatus(id: string, status: string): Promise<boolean> {
  const rows = (await supabaseRequest('GET', `apollo_orders?id=eq.${id}&select=status&limit=1`)) as { status: string }[]
  return rows?.[0]?.status === status
}

async function failOrder(id: string, fromStatus: string, message: string): Promise<void> {
  const rows = (await supabaseRequest(
    'PATCH', `apollo_orders?id=eq.${id}&status=eq.${fromStatus}`, { status: 'failed', error: message }, { returning: true },
  )) as ApolloOrder[]
  if (rows?.length) {
    await notify(`❌ Leadsfriday order${rows[0].leadsfriday_order_id ? ` #${rows[0].leadsfriday_order_id}` : ''} failed\n${message}`,
      { severity: 'warn', link: lumeLink('/import') })
  }
}

function abortKeyboard(id: string) {
  return { inline_keyboard: [[{ text: '⛔ Stop tracking', callback_data: `lfo_abort:${id}` }]] }
}

// ---- Phase: order ---------------------------------------------------------

interface LeadsfridayOrder {
  order_id: number
  status: string
  credits_deducted?: number
  new_balance?: number
}

async function phaseOrder(order: ApolloOrder): Promise<void> {
  if (!LEADSFRIDAY_API_TOKEN) throw new Error('LEADSFRIDAY_API_TOKEN secret is not set')
  if (!order.apollo_url) throw new Error('order: no apollo_url')
  const count = Math.max(500, order.contact_count ?? 500)

  // Claim before paying: a replay finds zero rows and places no second order.
  if (!(await claimStatus(order.id, 'ordering', { status: 'ordered', contact_count: count }, '&leadsfriday_order_id=is.null'))) {
    console.log('[leadsfriday-order] order: already placed, skipping'); return
  }

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const form = new FormData()
  form.set('search_url', order.apollo_url)
  form.set('results_file_name', `apollo-${stamp}.csv`)
  form.set('contact_count', String(count))
  form.set('verify_emails', 'yes')
  form.set('note', `telegram apollo link ${order.id}`)

  const res = await fetch(`${LEADSFRIDAY_BASE}/api/export-apollo/`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LEADSFRIDAY_API_TOKEN}` },
    body: form,
  })
  if (res.status === 403) { await failOrder(order.id, 'ordered', `Leadsfriday: insufficient credits for ${count} contacts — top up and paste the link again`); return }
  if (res.status === 401) { await failOrder(order.id, 'ordered', 'Leadsfriday rejected the token (401) — check the LEADSFRIDAY_API_TOKEN secret'); return }
  if (!res.ok) { await failOrder(order.id, 'ordered', `Leadsfriday ${res.status}: ${(await res.text()).slice(0, 300)}`); return }

  const placed = await res.json() as LeadsfridayOrder
  if (!placed.order_id) { await failOrder(order.id, 'ordered', `Leadsfriday returned no order_id: ${JSON.stringify(placed).slice(0, 300)}`); return }

  await heartbeat(order.id, {
    leadsfriday_order_id: placed.order_id,
    leadsfriday_status: placed.status ?? 'pending',
    credits_deducted: placed.credits_deducted ?? null,
    new_balance: placed.new_balance ?? null,
  })

  const deducted = placed.credits_deducted !== undefined ? `${placed.credits_deducted} credits deducted` : 'credits deducted: not reported'
  const balance = placed.new_balance !== undefined ? ` · balance ${placed.new_balance}` : ''
  const sent = await notify(
    `💳 Leadsfriday order #${placed.order_id} placed\n` +
    `${count} contacts (verified emails) from your Apollo link\n` +
    `${deducted}${balance}\n\n` +
    `I'll pull the CSV as soon as it's delivered and send you the usual Approve / Deny prompt.`,
    { severity: 'urgent', link: lumeLink('/import') },
    abortKeyboard(order.id),
  )
  const mid = (sent?.result as { message_id?: number } | undefined)?.message_id
  if (mid) await supabaseRequest('PATCH', `apollo_orders?id=eq.${order.id}`, { telegram_message_id: mid })

  selfInvoke({ order_id: order.id, phase: 'poll', ordered_at: new Date().toISOString() })
}

// ---- Phase: poll -> ingest ------------------------------------------------

interface LeadsfridayStatus {
  status: string
  delivered_count?: number
  download_url?: string | null
}

async function phasePoll(order: ApolloOrder, payload: Payload, startedAt: number): Promise<void> {
  if (!LEADSFRIDAY_API_TOKEN) throw new Error('LEADSFRIDAY_API_TOKEN secret is not set')
  if (!order.leadsfriday_order_id) throw new Error('poll: no leadsfriday_order_id')
  const orderedAt = payload.ordered_at ?? order.created_at

  while (true) {
    const res = await fetch(`${LEADSFRIDAY_BASE}/api/export-apollo/${order.leadsfriday_order_id}/`, {
      headers: { 'Authorization': `Bearer ${LEADSFRIDAY_API_TOKEN}` },
    })
    if (res.status === 401) throw new Error('Leadsfriday rejected the token (401) — check the LEADSFRIDAY_API_TOKEN secret')
    if (res.status === 404) { await failOrder(order.id, 'ordered', `Leadsfriday has no order #${order.leadsfriday_order_id}`); return }
    if (!res.ok) throw new Error(`Leadsfriday status ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const st = await res.json() as LeadsfridayStatus

    if (st.status === 'delivered') {
      if (!st.download_url) throw new Error('Leadsfriday says delivered but gave no download_url')
      await ingest(order, st)
      return
    }
    if (st.status === 'cancelled') { await failOrder(order.id, 'ordered', 'Leadsfriday cancelled the order'); return }

    if (!(await stillInStatus(order.id, 'ordered'))) { console.log('[leadsfriday-order] poll: order left ordered (stopped?), exiting'); return }
    await heartbeat(order.id, { leadsfriday_status: st.status })

    if (Date.now() - new Date(orderedAt).getTime() > POLL_GIVE_UP_MS) {
      await failOrder(order.id, 'ordered', 'Leadsfriday did not deliver within 12 hours — paste the order id again later to retry')
      return
    }
    if (CHUNK_LIMIT_MS - (Date.now() - startedAt) < POLL_SLEEP_MS + 15_000) {
      selfInvoke({ order_id: order.id, phase: 'poll', ordered_at: orderedAt })
      return
    }
    await new Promise(r => setTimeout(r, POLL_SLEEP_MS))
  }
}

// Delivered: fetch the CSV now (the URL expires), store it where dropped files
// go, create the same telegram_ingests row handleDocument creates, and send
// the owner the same prompt. From here the existing pipeline owns it.
async function ingest(order: ApolloOrder, st: LeadsfridayStatus): Promise<void> {
  const dl = await fetch(st.download_url!, { redirect: 'follow' })
  if (!dl.ok) throw new Error(`Leadsfriday download failed (${dl.status})`)
  const bytes = new Uint8Array(await dl.arrayBuffer())

  const storagePath = `leadsfriday/${order.id}.csv`
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/raw-uploads/${storagePath}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'text/csv', 'x-upsert': 'true' },
    body: bytes,
  })
  if (!up.ok) throw new Error(`Storage upload failed (${up.status}): ${await up.text()}`)

  const { headers, rows } = parseCsv(new TextDecoder().decode(bytes))
  const detected = detectEmailColumn(headers)
  const filename = `leadsfriday-${order.leadsfriday_order_id}.csv`

  const ok = await claimStatus(order.id, 'ordered', {
    status: 'delivered',
    leadsfriday_status: 'delivered',
    storage_path: `raw-uploads/${storagePath}`,
  })
  if (!ok) { console.log('[leadsfriday-order] ingest: another invocation already stored the delivery'); return }

  const ingestRows = (await supabaseRequest('POST', 'telegram_ingests', {
    telegram_chat_id: TELEGRAM_CHAT_ID,
    sender_chat_id: TELEGRAM_CHAT_ID,
    sender_name: 'Leadsfriday (Apollo link)',
    sender_platform: 'telegram',
    filename,
    storage_path: storagePath,
    row_count: rows.length,
    detected_email_column: detected,
    status: 'awaiting_approval',
  }, { returning: true })) as { id: string }[]
  const ing = ingestRows[0]

  const columnLine = detected
    ? `Email column: ${detected}`
    : "⚠️ Couldn't confidently detect an email column — you'll need to handle this one via the dashboard."
  const ownerText = [
    `📥 Leadsfriday delivered order #${order.leadsfriday_order_id}`,
    `File: ${filename}`,
    `Rows: ${rows.length}${st.delivered_count !== undefined && st.delivered_count !== rows.length ? ` (Leadsfriday reports ${st.delivered_count})` : ''}`,
    columnLine,
  ].join('\n')
  const keyboard = detected
    ? { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${ing.id}` },
        { text: '🔎 Approve + Enrich', callback_data: `approve_enrich:${ing.id}` },
        { text: '❌ Deny', callback_data: `deny:${ing.id}` },
      ]] }
    : { inline_keyboard: [[{ text: '❌ Deny', callback_data: `deny:${ing.id}` }]] }

  const sent = await notify(ownerText, {
    severity: 'urgent', link: lumeLink(`/validate?gate=ingest_approval:${ing.id}`), scope: 'validation',
    dedupe_key: gateKey(ing.id, 'ingest_approval'),
  }, keyboard)
  const mid = (sent?.result as { message_id?: number } | undefined)?.message_id
  if (mid) await supabaseRequest('PATCH', `telegram_ingests?id=eq.${ing.id}`, { telegram_message_id: mid })

  await supabaseRequest('PATCH', `apollo_orders?id=eq.${order.id}&status=eq.delivered`, { status: 'ingested', ingest_id: ing.id })

  // Strip the Stop button from the receipt now that there is nothing to stop.
  if (order.telegram_message_id) {
    await tg('editMessageReplyMarkup', { chat_id: TELEGRAM_CHAT_ID, message_id: order.telegram_message_id, reply_markup: { inline_keyboard: [] } })
  }
  console.log(`[leadsfriday-order] ingested #${order.leadsfriday_order_id}: ${rows.length} rows -> ingest ${ing.id}`)
}

// ---- Dispatch -------------------------------------------------------------

async function run(payload: Payload): Promise<void> {
  const startedAt = Date.now()
  const order = await loadOrder(payload.order_id)
  const phase = payload.phase ?? PHASE_FOR_STATUS[order.status]
  if (!phase) { console.log(`[leadsfriday-order] nothing to do for status ${order.status}`); return }
  if (STATUS_FOR_PHASE[phase] !== order.status) {
    console.log(`[leadsfriday-order] phase ${phase} does not match status ${order.status}, skipping`); return
  }
  try {
    if (phase === 'order') await phaseOrder(order)
    else await phasePoll(order, payload, startedAt)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[leadsfriday-order] ${phase} failed:`, message)
    const current = await loadOrder(order.id).catch(() => null)
    if (current && ['ordering', 'ordered', 'delivered'].includes(current.status)) {
      await failOrder(order.id, current.status, message)
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  let payload: Payload
  try {
    payload = await req.json() as Payload
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  if (!payload.order_id) {
    return new Response(JSON.stringify({ error: 'order_id is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  EdgeRuntime.waitUntil(run(payload).catch(err => console.error('[leadsfriday-order] unhandled:', err)))
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
})
