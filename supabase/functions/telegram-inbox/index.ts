// Supabase Edge Function: telegram-inbox
// Webhook for the Telegram bot: a friend sends a .csv document, the owner
// gets an Approve/Deny prompt, and only on approval does the file enter the
// normal validation pipeline (validation_jobs/validation_rows + email-validator).

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID')!
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')!
const SLACK_BOT_TOKEN = Deno.env.get('SLACK_BOT_TOKEN') ?? ''
const INSTANTLY_API_KEY = Deno.env.get('INSTANTLY_API_KEY') ?? ''

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
const INSTANTLY_BASE_URL = 'https://api.instantly.ai/api/v2'

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
  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const res = await fetch(url, {
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

async function slackPostMessage(channel: string, text: string): Promise<void> {
  if (!SLACK_BOT_TOKEN || !channel) return
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel, text }),
    })
  } catch {
    // Non-critical — ignore Slack errors
  }
}

// Replies to whichever platform the ingest came from.
async function replyToSender(ingest: TelegramIngest, text: string): Promise<void> {
  if (ingest.sender_platform === 'slack') {
    await slackPostMessage(ingest.slack_channel_id ?? '', text)
  } else {
    await tg('sendMessage', { chat_id: ingest.sender_chat_id, text })
  }
}

// ---- Compact CSV parsing (mirrors app/api/validate/start/route.ts;
// edge functions don't share code with the Next.js app — see design doc) ----

const TIER1_NAMES = new Set(['email', 'work_email', 'business_email'])
const PERSONAL_SUBSTRINGS = ['personal']

// Apollo exports carry two free-text columns that nothing downstream reads but
// which dominate the file: on a real 14.2MB export, Keywords averaged ~844
// chars/row and Technologies ~630, together 76% of the bytes. Dropping them at
// intake keeps them out of row_data, out of every CSV rebuild, and out of the
// 20MB Telegram ceiling.
const DROPPED_COLUMNS = new Set(['keywords', 'technologies'])

function keptColumnIndexes(headers: string[]): number[] {
  const keep: number[] = []
  for (let i = 0; i < headers.length; i++) {
    if (!DROPPED_COLUMNS.has(normalizeHeader(headers[i]))) keep.push(i)
  }
  return keep
}

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
    if (TIER1_NAMES.has(norm)) tier1.push(headers[i])
    else if (!isPersonal && (norm.includes('email') || norm.includes('mail'))) tier3.push(headers[i])
  }
  if (tier1.length === 1) return { column: tier1[0] }
  if (tier1.length > 1) return { ambiguous: tier1 }
  if (tier3.length === 1) return { column: tier3[0] }
  if (tier3.length > 1) return { ambiguous: tier3 }
  return { error: 'No email column found in CSV' }
}

// Slice-based rather than char-by-char. The previous version built each cell
// with `current += char`, which on a wide CSV generates one intermediate
// string per character — a 13MB file peaked at 444MB of heap and the worker
// was killed with a 546 before it could even reply to Telegram. This produces
// byte-identical output (verified against the old parser on quoted commas,
// doubled quotes, empty fields and trailing quotes) at a fraction of the cost.
function parseCSVRow(row: string): string[] {
  const out: string[] = []
  let i = 0
  while (i <= row.length) {
    if (row.charCodeAt(i) === 34 /* " */) {
      let val = ''
      i++
      let start = i
      while (i < row.length) {
        if (row.charCodeAt(i) === 34) {
          if (row.charCodeAt(i + 1) === 34) { val += row.slice(start, i) + '"'; i += 2; start = i; continue }
          break
        }
        i++
      }
      val += row.slice(start, i)
      out.push(val)
      i++ // closing quote
      if (row.charCodeAt(i) === 44 /* , */) i++
      else if (i >= row.length) break
    } else {
      const next = row.indexOf(',', i)
      if (next === -1) { out.push(row.slice(i)); break }
      out.push(row.slice(i, next))
      i = next + 1
    }
  }
  return out
}

// Yields one line at a time instead of materializing a lines array, so the
// caller can parse-and-release rather than holding every parsed row at once.
function* iterLines(text: string): Generator<string> {
  let start = 0
  while (start < text.length) {
    let nl = text.indexOf('\n', start)
    if (nl === -1) nl = text.length
    let end = nl
    if (end > start && text.charCodeAt(end - 1) === 13 /* \r */) end--
    if (end > start) yield text.slice(start, end)
    start = nl + 1
  }
}

// ---- Intake-only helpers: header + row count straight off the raw bytes ----
// Intake never needs the parsed body; approval re-reads the file and parses it
// then. 0x0A can't appear inside a UTF-8 multi-byte sequence, so counting
// newline bytes is exact without decoding the whole file.

function headerFromBytes(bytes: Uint8Array): string {
  let end = bytes.indexOf(10)
  if (end === -1) end = bytes.length
  let sliceEnd = end
  if (sliceEnd > 0 && bytes[sliceEnd - 1] === 13) sliceEnd--
  return new TextDecoder().decode(bytes.subarray(0, sliceEnd))
}

function countDataRows(bytes: Uint8Array): number {
  let newlines = 0
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) newlines++
  const endsWithNewline = bytes.length > 0 && bytes[bytes.length - 1] === 10
  const totalLines = endsWithNewline ? newlines : newlines + 1
  return Math.max(0, totalLines - 1) // minus the header
}

// ---- Telegram update shape (only the fields we use) ----

interface TelegramUpdate {
  message?: {
    message_id: number
    from?: { id: number; first_name?: string; username?: string }
    chat: { id: number }
    document?: { file_id: string; file_name?: string }
    text?: string
    reply_to_message?: { message_id: number }
  }
  callback_query?: {
    id: string
    from: { id: number; first_name?: string; username?: string }
    data?: string
    message?: { message_id: number; chat: { id: number } }
  }
}

interface TelegramIngest {
  id: string
  telegram_chat_id: string
  telegram_message_id: number | null
  sender_chat_id: string
  sender_name: string | null
  sender_platform: string
  slack_channel_id: string | null
  filename: string
  storage_path: string
  status: string
  row_count: number | null
}

function senderLabel(from?: { first_name?: string; username?: string }): string {
  if (!from) return 'Unknown'
  return from.username ? `@${from.username}` : (from.first_name ?? 'Unknown')
}

async function handleDocument(message: NonNullable<TelegramUpdate['message']>): Promise<void> {
  const doc = message.document!
  const senderChatId = String(message.chat.id)
  const name = doc.file_name ?? 'upload.csv'

  if (!name.toLowerCase().endsWith('.csv')) {
    await tg('sendMessage', {
      chat_id: senderChatId,
      text: "Please send a .csv file directly — that's the only format I can check right now.",
    })
    return
  }

  const fileInfo = await tg('getFile', { file_id: doc.file_id })
  const filePath = (fileInfo.result as { file_path?: string } | undefined)?.file_path
  if (!filePath) {
    const reason = (fileInfo as { description?: string }).description ?? 'unknown error'
    const tooBig = reason.toLowerCase().includes('too big')
    console.error('[telegram-inbox] getFile failed:', JSON.stringify(fileInfo))
    await tg('sendMessage', {
      chat_id: senderChatId,
      text: tooBig
        ? "That file is over Telegram's 20MB bot download limit — split it into smaller files, or send it another way."
        : 'Could not read that file — try sending it again.',
    })
    await tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: `⚠️ getFile failed for ${name}: ${reason}` })
    return
  }

  // Keep the file as bytes: the header and row count come straight off them,
  // and the same buffer is what gets uploaded. Decoding the whole CSV to a
  // string here (let alone parsing it) is what used to blow the worker's
  // memory limit on a wide file.
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`)
  const bytes = new Uint8Array(await fileRes.arrayBuffer())
  const headers = parseCSVRow(headerFromBytes(bytes))
  const rowCount = countDataRows(bytes)
  const detection = detectEmailColumn(headers)
  const detectedColumn = 'column' in detection ? detection.column : null

  const storagePath = `telegram/${crypto.randomUUID()}.csv`
  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/raw-uploads/${storagePath}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'text/csv',
      'x-upsert': 'true',
    },
    body: bytes,
  })
  if (!uploadRes.ok) {
    await tg('sendMessage', { chat_id: senderChatId, text: 'Something went wrong saving your file — try again in a bit.' })
    return
  }

  const senderName = senderLabel(message.from)

  const ingestRows = (await supabaseRequest('POST', 'telegram_ingests', {
    telegram_chat_id: TELEGRAM_CHAT_ID,
    sender_chat_id: senderChatId,
    sender_name: senderName,
    filename: name,
    storage_path: storagePath,
    row_count: rowCount,
    detected_email_column: detectedColumn,
    status: 'awaiting_approval',
  }, { returning: true })) as TelegramIngest[]
  const ingest = ingestRows[0]

  await tg('sendMessage', { chat_id: senderChatId, text: 'Got your file — checking with the owner. Hang tight.' })

  const columnLine = detectedColumn
    ? `Email column: ${detectedColumn}`
    : "⚠️ Couldn't confidently detect an email column — you'll need to handle this one via the dashboard."

  const ownerText = [
    `📥 New CSV from ${senderName}`,
    `File: ${name}`,
    `Rows: ${rowCount}`,
    columnLine,
  ].join('\n')

  const keyboard = detectedColumn
    ? { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${ingest.id}` },
        { text: '🔎 Approve + Enrich', callback_data: `approve_enrich:${ingest.id}` },
        { text: '❌ Deny', callback_data: `deny:${ingest.id}` },
      ]] }
    : { inline_keyboard: [[
        { text: '❌ Deny', callback_data: `deny:${ingest.id}` },
      ]] }

  const sent = await tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: ownerText, reply_markup: keyboard })
  const ownerMessageId = (sent.result as { message_id?: number } | undefined)?.message_id
  if (ownerMessageId) {
    await supabaseRequest('PATCH', `telegram_ingests?id=eq.${ingest.id}`, { telegram_message_id: ownerMessageId })
  }
}

// ---- Instantly push: campaign selection, barriers, company-name review ----

interface InstantlyJob {
  id: string
  filename: string
  valid_count: number
  instantly_status: string
  instantly_campaign_id: string | null
  instantly_campaign_name: string | null
  instantly_campaign_candidates: { id: string; name: string }[] | null
  location_barrier: boolean
  company_barrier: boolean
  company_strict: boolean
}

const INSTANTLY_JOB_SELECT =
  'id,filename,valid_count,instantly_status,instantly_campaign_id,instantly_campaign_name,' +
  'instantly_campaign_candidates,location_barrier,company_barrier,company_strict'

async function getInstantlyJob(jobId: string): Promise<InstantlyJob | null> {
  const jobs = (await supabaseRequest(
    'GET',
    `validation_jobs?id=eq.${jobId}&select=${INSTANTLY_JOB_SELECT}`,
  )) as InstantlyJob[]
  return jobs?.[0] ?? null
}

// Campaign lookup by NAME — the owner never has to paste a raw campaign ID.
// Instantly's own server-side search does the matching; deleted campaigns
// (status < 0) are dropped so a dead name can't be picked.
async function searchCampaigns(query: string): Promise<{ id: string; name: string; status: number }[]> {
  const res = await fetch(
    `${INSTANTLY_BASE_URL}/campaigns?limit=50&search=${encodeURIComponent(query)}`,
    { headers: { 'Authorization': `Bearer ${INSTANTLY_API_KEY}` } },
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Instantly campaign search failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const data = await res.json() as { items?: { id: string; name: string; status: number }[] }
  return (data.items ?? []).filter(c => c.status >= 0)
}

function statusLabel(status: number): string {
  if (status === 0) return 'draft'
  if (status === 1) return 'active'
  if (status === 2) return 'paused'
  if (status === 3) return 'completed'
  return String(status)
}

async function sendCampaignPrompt(jobId: string, text: string): Promise<void> {
  const sent = await tg('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    reply_markup: { force_reply: true },
  })
  const messageId = (sent.result as { message_id?: number } | undefined)?.message_id
  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, {
    instantly_prompt_message_id: messageId ?? null,
    instantly_status: 'awaiting_campaign',
  })
}

function barrierScreen(job: InstantlyJob): { text: string; reply_markup: unknown } {
  const text = [
    `📤 Push to: ${job.instantly_campaign_name}`,
    `File: ${job.filename}`,
    `Valid leads: ${job.valid_count}`,
    ``,
    `Barriers`,
    job.location_barrier
      ? `📍 Location: ON — only rows with a resolved city and high confidence`
      : `📍 Location: OFF — keep every row, blank out unknown cities`,
    job.company_barrier
      ? `🏢 Company: ON — review the first 10 names, drop junk ones`
      : `🏢 Company: OFF — no review, push names as normalized`,
  ].join('\n')

  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: `📍 Location: ${job.location_barrier ? 'ON' : 'OFF'}`, callback_data: `bar_loc:${job.id}` },
          { text: `🏢 Company: ${job.company_barrier ? 'ON' : 'OFF'}`, callback_data: `bar_co:${job.id}` },
        ],
        [
          { text: '▶️ Continue', callback_data: `push_next:${job.id}` },
          { text: '✖️ Cancel', callback_data: `push_cancel:${job.id}` },
        ],
      ],
    },
  }
}

async function showBarrierScreen(job: InstantlyJob, edit?: { chatId: number; messageId: number }): Promise<void> {
  await supabaseRequest('PATCH', `validation_jobs?id=eq.${job.id}`, { instantly_status: 'configuring' })
  const screen = barrierScreen(job)
  if (edit) {
    await tg('editMessageText', {
      chat_id: edit.chatId,
      message_id: edit.messageId,
      text: screen.text,
      reply_markup: screen.reply_markup,
    })
  } else {
    await tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: screen.text, reply_markup: screen.reply_markup })
  }
}

interface PushPreview {
  ok: boolean
  eligible: number
  filtered: number
  junk: number
  missingFirstName: number
  blankLocation: number
  samples: { original: string; normalized: string }[]
  strict: boolean
  error?: string
}

// The preview is produced by instantly-push itself, not reimplemented here —
// the names shown for approval are the exact ones that get pushed.
async function fetchPreview(jobId: string): Promise<PushPreview> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/instantly-push`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ job_id: jobId, mode: 'preview' }),
  })
  return await res.json() as PushPreview
}

async function showCompanyReview(job: InstantlyJob, edit?: { chatId: number; messageId: number }): Promise<void> {
  await supabaseRequest('PATCH', `validation_jobs?id=eq.${job.id}`, { instantly_status: 'reviewing_company' })
  const preview = await fetchPreview(job.id)

  if (!preview.ok) {
    await tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: `⚠️ Couldn't build the name preview: ${preview.error}` })
    return
  }

  const sampleLines = preview.samples.length > 0
    ? preview.samples.map((s, i) => {
        const n = String(i + 1).padStart(2, ' ')
        return s.original === s.normalized
          ? `${n}. ${s.normalized}`
          : `${n}. ${s.normalized}   ← ${s.original}`
      })
    : ['(no eligible rows)']

  const notes: string[] = []
  if (preview.junk > 0) notes.push(`${preview.junk} junk name${preview.junk === 1 ? '' : 's'} dropped`)
  if (preview.missingFirstName > 0) notes.push(`${preview.missingFirstName} with no first name`)
  if (preview.blankLocation > 0) notes.push(`${preview.blankLocation} will send a blank location`)

  const text = [
    `🏢 Company names — ${job.instantly_campaign_name}`,
    preview.strict ? `Mode: stricter (descriptive suffixes stripped)` : `Mode: standard (legal suffixes stripped)`,
    ``,
    ...sampleLines,
    ``,
    `${preview.eligible} ready to push · ${preview.filtered} filtered out`,
    ...(notes.length > 0 ? [notes.join(' · ')] : []),
  ].join('\n')

  const toggleButton = preview.strict
    ? { text: '↩️ Standard names', callback_data: `push_std:${job.id}` }
    : { text: '✂️ Stricter names', callback_data: `push_strict:${job.id}` }

  const reply_markup = {
    inline_keyboard: [
      [{ text: '✅ Push these', callback_data: `push_go:${job.id}` }, toggleButton],
      [{ text: '✖️ Cancel', callback_data: `push_cancel:${job.id}` }],
    ],
  }

  if (edit) {
    await tg('editMessageText', { chat_id: edit.chatId, message_id: edit.messageId, text, reply_markup })
  } else {
    await tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text, reply_markup })
  }
}

async function startPush(job: InstantlyJob): Promise<void> {
  await supabaseRequest('PATCH', `validation_jobs?id=eq.${job.id}`, { instantly_status: 'pushing' })
  fetch(`${SUPABASE_URL}/functions/v1/instantly-push`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ job_id: job.id }),
  }).catch(err => console.error('[telegram-inbox] instantly-push invoke error:', err))
}

// A plain-text reply to the campaign prompt. Telegram's reply threading is the
// whole state machine: reply_to_message.message_id identifies the job.
async function handleCampaignNameReply(
  text: string,
  repliedToMessageId: number,
): Promise<boolean> {
  const jobs = (await supabaseRequest(
    'GET',
    `validation_jobs?instantly_prompt_message_id=eq.${repliedToMessageId}&select=${INSTANTLY_JOB_SELECT}`,
  )) as InstantlyJob[]
  const job = jobs?.[0]
  if (!job) return false
  if (job.instantly_status !== 'awaiting_campaign') {
    await tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: 'That campaign prompt was already answered.' })
    return true
  }

  const query = text.trim()
  if (!query) return true

  let matches: { id: string; name: string; status: number }[]
  try {
    matches = await searchCampaigns(query)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: `⚠️ Campaign lookup failed: ${message}` })
    return true
  }

  if (matches.length === 0) {
    await sendCampaignPrompt(job.id, `No campaign matched "${query}". Reply with another name.`)
    return true
  }

  // An exact name match wins outright even when it shares a prefix with others
  // ("Scaleport - R3" alongside "Scaleport - Managers").
  const exact = matches.filter(c => c.name.trim().toLowerCase() === query.toLowerCase())
  const resolved = exact.length === 1 ? exact[0] : (matches.length === 1 ? matches[0] : null)

  if (resolved) {
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${job.id}`, {
      instantly_campaign_id: resolved.id,
      instantly_campaign_name: resolved.name,
      instantly_campaign_candidates: null,
    })
    const refreshed = await getInstantlyJob(job.id)
    if (refreshed) await showBarrierScreen(refreshed)
    return true
  }

  // Several hits — store them so a 2-byte index in callback_data can resolve
  // back to a full campaign id (Telegram caps callback_data at 64 bytes).
  const candidates = matches.slice(0, 8).map(c => ({ id: c.id, name: c.name }))
  await supabaseRequest('PATCH', `validation_jobs?id=eq.${job.id}`, {
    instantly_campaign_candidates: candidates,
    instantly_status: 'choosing_campaign',
  })
  await tg('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text: `${matches.length} campaigns match "${query}" — which one?`,
    reply_markup: {
      inline_keyboard: matches.slice(0, 8).map((c, i) => [
        { text: `${c.name} (${statusLabel(c.status)})`, callback_data: `camp_pick:${job.id}:${i}` },
      ]),
    },
  })
  return true
}

async function handlePushCallback(
  action: string,
  jobId: string,
  extra: string | undefined,
  cb: NonNullable<TelegramUpdate['callback_query']>,
): Promise<void> {
  const job = await getInstantlyJob(jobId)
  if (!job) {
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Job not found.' })
    return
  }

  const edit = cb.message ? { chatId: cb.message.chat.id, messageId: cb.message.message_id } : undefined

  if (action === 'push_cancel') {
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { instantly_status: 'cancelled' })
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Cancelled.' })
    if (edit) {
      await tg('editMessageText', {
        chat_id: edit.chatId,
        message_id: edit.messageId,
        text: `✖️ Instantly push cancelled — ${job.filename}`,
      })
    }
    return
  }

  if (action === 'camp_pick') {
    const idx = Number(extra)
    const candidate = job.instantly_campaign_candidates?.[idx]
    if (!candidate) {
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'That option expired.' })
      return
    }
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, {
      instantly_campaign_id: candidate.id,
      instantly_campaign_name: candidate.name,
      instantly_campaign_candidates: null,
    })
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: candidate.name })
    const refreshed = await getInstantlyJob(jobId)
    if (refreshed) await showBarrierScreen(refreshed, edit)
    return
  }

  if (action === 'bar_loc' || action === 'bar_co') {
    const field = action === 'bar_loc' ? 'location_barrier' : 'company_barrier'
    const next = action === 'bar_loc' ? !job.location_barrier : !job.company_barrier
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { [field]: next })
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: `${action === 'bar_loc' ? 'Location' : 'Company'}: ${next ? 'ON' : 'OFF'}` })
    const refreshed = await getInstantlyJob(jobId)
    if (refreshed) await showBarrierScreen(refreshed, edit)
    return
  }

  if (action === 'push_next') {
    await tg('answerCallbackQuery', { callback_query_id: cb.id })
    if (job.company_barrier) {
      await showCompanyReview(job, edit)
    } else {
      await startPush(job)
      if (edit) {
        await tg('editMessageText', {
          chat_id: edit.chatId,
          message_id: edit.messageId,
          text: `📤 Pushing to ${job.instantly_campaign_name} — ${job.filename}`,
        })
      }
    }
    return
  }

  if (action === 'push_strict' || action === 'push_std') {
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { company_strict: action === 'push_strict' })
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: action === 'push_strict' ? 'Stricter names' : 'Standard names' })
    const refreshed = await getInstantlyJob(jobId)
    if (refreshed) await showCompanyReview(refreshed, edit)
    return
  }

  if (action === 'push_go') {
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Pushing.' })
    await startPush(job)
    if (edit) {
      await tg('editMessageText', {
        chat_id: edit.chatId,
        message_id: edit.messageId,
        text: `📤 Pushing to ${job.instantly_campaign_name} — ${job.filename}`,
      })
    }
    return
  }
}

async function handleEnrichDecision(action: 'enrich_confirm' | 'enrich_skip', jobId: string, callbackQueryId: string): Promise<void> {
  if (action === 'enrich_skip') {
    // Turning enrich off means email-validator's next pass skips the
    // handoff check entirely and goes straight to building the CSV.
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { enrich: false })
  } else {
    await supabaseRequest(
      'PATCH',
      `validation_rows?job_id=eq.${jobId}&status=eq.valid&enrichment_status=eq.skipped`,
      { enrichment_status: 'pending' },
    )
  }

  await tg('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: action === 'enrich_skip' ? 'Skipping enrichment.' : 'Enriching now.',
  })

  const nextFunction = action === 'enrich_skip' ? 'email-validator' : 'operating-city-enricher'
  fetch(`${SUPABASE_URL}/functions/v1/${nextFunction}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ job_id: jobId }),
  }).catch(err => console.error(`[telegram-inbox] ${nextFunction} invoke error:`, err))
}

const PUSH_ACTIONS = new Set([
  'camp_pick', 'bar_loc', 'bar_co', 'push_next', 'push_go', 'push_strict', 'push_std', 'push_cancel',
])

async function handleCallback(cb: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
  const [action, targetId, extra] = (cb.data ?? '').split(':')

  if ((action === 'enrich_confirm' || action === 'enrich_skip') && targetId) {
    await handleEnrichDecision(action, targetId, cb.id)
    return
  }

  if (PUSH_ACTIONS.has(action) && targetId) {
    await handlePushCallback(action, targetId, extra, cb)
    return
  }

  const ingestId = targetId
  if (!ingestId || (action !== 'approve' && action !== 'approve_enrich' && action !== 'deny')) {
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Unrecognized action.' })
    return
  }

  // Acknowledge the tap FIRST. Telegram spins the button until this returns,
  // and loading a large file used to take long enough that the owner assumed
  // nothing happened and tapped again — which is how one file became three
  // identical jobs.
  await tg('answerCallbackQuery', {
    callback_query_id: cb.id,
    text: action === 'deny' ? 'Denying…' : 'Approved — loading rows…',
  })

  const ingests = (await supabaseRequest('GET', `telegram_ingests?id=eq.${ingestId}&select=*`)) as TelegramIngest[]
  const ingest = ingests[0]
  if (!ingest) return
  if (ingest.status !== 'awaiting_approval') return

  if (action === 'deny') {
    // Same conditional claim as approve, so a double-tap can't delete the
    // stored file twice or race an approve that landed first.
    const rejected = (await supabaseRequest(
      'PATCH',
      `telegram_ingests?id=eq.${ingestId}&status=eq.awaiting_approval`,
      { status: 'rejected' },
      { returning: true },
    )) as TelegramIngest[]
    if (!rejected || rejected.length === 0) return

    await fetch(`${SUPABASE_URL}/storage/v1/object/raw-uploads/${ingest.storage_path}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    })
    if (ingest.telegram_message_id) {
      await tg('editMessageText', {
        chat_id: ingest.telegram_chat_id,
        message_id: ingest.telegram_message_id,
        text: `❌ Denied — ${ingest.filename}`,
      })
    }
    await replyToSender(ingest, "Your file wasn't approved for processing right now.")
    return
  }

  // action === 'approve' | 'approve_enrich'
  //
  // Claim the ingest BEFORE doing any work. The status read above is not a
  // guard on its own: it used to be followed by a download and thousands of
  // inserts, and only then the flip to 'approved'. On a 7,288-row file that
  // window was seconds wide, so three taps sailed past the check and each
  // started its own job. This conditional update is atomic — it only matches
  // while the row is still awaiting_approval, so exactly one tap can win.
  const claimed = (await supabaseRequest(
    'PATCH',
    `telegram_ingests?id=eq.${ingestId}&status=eq.awaiting_approval`,
    { status: 'approved' },
    { returning: true },
  )) as TelegramIngest[]
  if (!claimed || claimed.length === 0) return // another tap already won

  const enrich = action === 'approve_enrich'

  if (ingest.telegram_message_id) {
    await tg('editMessageText', {
      chat_id: ingest.telegram_chat_id,
      message_id: ingest.telegram_message_id,
      text: `⏳ Loading ${ingest.row_count ?? 0} rows — ${ingest.filename}`,
    })
  }

  const dl = await fetch(`${SUPABASE_URL}/storage/v1/object/raw-uploads/${ingest.storage_path}`, {
    headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  })
  const csvText = await dl.text()

  // Parse the header alone first — the body is streamed below rather than
  // parsed up front, so a wide CSV never has every row in memory at once.
  const firstLine = iterLines(csvText).next()
  const headers = firstLine.done ? [] : parseCSVRow(firstLine.value)
  const detection = detectEmailColumn(headers)
  if (!('column' in detection)) {
    // The callback was already answered above, so report this as a message —
    // a second answerCallbackQuery for the same tap is rejected by Telegram.
    await tg('sendMessage', {
      chat_id: TELEGRAM_CHAT_ID,
      text: `⚠️ Email column no longer detectable in ${ingest.filename} — nothing was loaded.`,
    })
    return
  }
  const colIndex = headers.indexOf(detection.column)
  const jobId = crypto.randomUUID()

  // Drop the bulk columns before anything is stored. keptIdx maps a parsed
  // row back onto the surviving headers, so row_data and column_order stay in
  // step with each other.
  const keptIdx = keptColumnIndexes(headers)
  const keptHeaders = keptIdx.map(i => headers[i])
  const droppedCount = headers.length - keptHeaders.length

  await supabaseRequest('POST', 'validation_jobs', {
    id: jobId,
    filename: ingest.filename,
    total_rows: ingest.row_count ?? 0,
    processed_rows: 0,
    valid_count: 0,
    invalid_count: 0,
    status: 'pending',
    source: 'telegram',
    column_order: keptHeaders,
    enrich,
    enriched_rows: 0,
  })

  // enrichment_status starts at its DB default ('skipped') for every row —
  // email-validator is what flips valid rows to 'pending' once it knows
  // which emails are actually worth enriching.
  //
  // Batches flush on whichever comes first: a row count, or an approximate
  // payload size. A fixed 500-row chunk was ~10MB of JSON on a wide file;
  // capping by bytes keeps each insert small regardless of row width.
  const MAX_BATCH_ROWS = 500
  const MAX_BATCH_BYTES = 1_000_000
  let batch: Record<string, unknown>[] = []
  let batchBytes = 0
  let rowIndex = 0
  let isHeader = true

  let missingEmail = 0

  for (const line of iterLines(csvText)) {
    if (isHeader) { isHeader = false; continue }
    const cells = parseCSVRow(line)
    const email = (cells[colIndex] ?? '').trim()
    if (!email) missingEmail++
    batch.push({
      job_id: jobId,
      email,
      row_index: rowIndex++,
      status: 'pending',
      row_data: Object.fromEntries(keptIdx.map(i => [headers[i], cells[i] ?? ''])),
    })
    batchBytes += line.length
    if (batch.length >= MAX_BATCH_ROWS || batchBytes >= MAX_BATCH_BYTES) {
      await supabaseRequest('POST', 'validation_rows', batch)
      batch = []
      batchBytes = 0
    }
  }
  if (batch.length > 0) await supabaseRequest('POST', 'validation_rows', batch)

  // row_count came from a newline scan at intake; rowIndex is what actually
  // parsed. Reconcile so progress percentages aren't computed off a stale total.
  if (rowIndex !== (ingest.row_count ?? 0)) {
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { total_rows: rowIndex })
  }
  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { rows_missing_email: missingEmail })

  await supabaseRequest('PATCH', `telegram_ingests?id=eq.${ingestId}`, { validation_job_id: jobId })

  // Rows that arrived without an address go through the finder first, then the
  // whole list — found and pre-existing addresses together — flows into
  // email-validator. With nothing missing, skip straight to validation.
  const nextFunction = missingEmail > 0 ? 'contact-email-finder' : 'email-validator'
  fetch(`${SUPABASE_URL}/functions/v1/${nextFunction}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ job_id: jobId }),
  }).catch(err => console.error(`[telegram-inbox] ${nextFunction} invoke error:`, err))

  const summary = [
    enrich ? `🔎 Approved + Enrich — ${ingest.filename}` : `✅ Approved — ${ingest.filename}`,
    `${rowIndex} rows loaded${droppedCount > 0 ? ` · ${droppedCount} bulk column${droppedCount === 1 ? '' : 's'} dropped` : ''}`,
    missingEmail > 0
      ? `${rowIndex - missingEmail} with an address · finding ${missingEmail} missing first`
      : `Validating all ${rowIndex} now`,
  ].join('\n')

  if (ingest.telegram_message_id) {
    await tg('editMessageText', {
      chat_id: ingest.telegram_chat_id,
      message_id: ingest.telegram_message_id,
      text: summary,
    })
  }
  await replyToSender(ingest, 'Approved — running now.')
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const secret = req.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (secret !== TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  let update: TelegramUpdate
  try {
    update = await req.json()
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  // Answer Telegram immediately and do the work in the background. Handling a
  // document inline meant a slow or heavy file left the request hanging until
  // the worker was killed; Telegram saw a failure, retried the same update
  // forever, and the sender got nothing back. Now a failure is reported into
  // the chat instead of turning into a retry storm.
  const work = (async () => {
    if (update.message?.document) {
      await handleDocument(update.message)
    } else if (update.callback_query) {
      await handleCallback(update.callback_query)
    } else if (update.message?.text && update.message.reply_to_message) {
      // The only plain text we act on is a reply to the Instantly campaign
      // prompt. Anything else falls through and is ignored as before.
      await handleCampaignNameReply(update.message.text, update.message.reply_to_message.message_id)
    }
    // All other update types are silently ignored.
  })().catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[telegram-inbox] handler error:', message)
    await tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: `⚠️ telegram-inbox error: ${message}` }).catch(() => {})
  })

  EdgeRuntime.waitUntil(work)

  return new Response('OK', { status: 200 })
})
