// Supabase Edge Function: telegram-inbox
// Webhook for the Telegram bot: a friend sends a .csv document, the owner
// gets an Approve/Deny prompt, and only on approval does the file enter the
// normal validation pipeline (validation_jobs/validation_rows + email-validator).

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID')!
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')!

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

// ---- Compact CSV parsing (mirrors app/api/validate/start/route.ts;
// edge functions don't share code with the Next.js app — see design doc) ----

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
    if (TIER1_NAMES.has(norm)) tier1.push(headers[i])
    else if (!isPersonal && (norm.includes('email') || norm.includes('mail'))) tier3.push(headers[i])
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
      if (inQuotes && row[i + 1] === '"') { current += '"'; i++ } else inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) { result.push(current); current = '' } else current += char
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

// ---- Telegram update shape (only the fields we use) ----

interface TelegramUpdate {
  message?: {
    message_id: number
    from?: { id: number; first_name?: string; username?: string }
    chat: { id: number }
    document?: { file_id: string; file_name?: string }
  }
  callback_query?: {
    id: string
    from: { id: number; first_name?: string; username?: string }
    data?: string
  }
}

interface TelegramIngest {
  id: string
  telegram_chat_id: string
  telegram_message_id: number | null
  sender_chat_id: string
  sender_name: string | null
  filename: string
  storage_path: string
  status: string
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

  const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`)
  const csvText = await fileRes.text()
  const { headers, rows } = parseCSV(csvText)
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
    body: new TextEncoder().encode(csvText),
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
    row_count: rows.length,
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
    `Rows: ${rows.length}`,
    columnLine,
  ].join('\n')

  const keyboard = detectedColumn
    ? { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${ingest.id}` },
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

async function handleCallback(cb: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
  const [action, ingestId] = (cb.data ?? '').split(':')
  if (!ingestId || (action !== 'approve' && action !== 'deny')) {
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Unrecognized action.' })
    return
  }

  const ingests = (await supabaseRequest('GET', `telegram_ingests?id=eq.${ingestId}&select=*`)) as TelegramIngest[]
  const ingest = ingests[0]
  if (!ingest) {
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not found.' })
    return
  }
  if (ingest.status !== 'awaiting_approval') {
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Already handled.' })
    return
  }

  if (action === 'deny') {
    await supabaseRequest('PATCH', `telegram_ingests?id=eq.${ingestId}`, { status: 'rejected' })
    await fetch(`${SUPABASE_URL}/storage/v1/object/raw-uploads/${ingest.storage_path}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    })
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Denied.' })
    if (ingest.telegram_message_id) {
      await tg('editMessageText', {
        chat_id: ingest.telegram_chat_id,
        message_id: ingest.telegram_message_id,
        text: `❌ Denied — ${ingest.filename}`,
      })
    }
    await tg('sendMessage', { chat_id: ingest.sender_chat_id, text: "Your file wasn't approved for processing right now." })
    return
  }

  // action === 'approve'
  const dl = await fetch(`${SUPABASE_URL}/storage/v1/object/raw-uploads/${ingest.storage_path}`, {
    headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  })
  const csvText = await dl.text()
  const { headers, rows } = parseCSV(csvText)
  const detection = detectEmailColumn(headers)
  if (!('column' in detection)) {
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Email column no longer detectable.' })
    return
  }
  const colIndex = headers.indexOf(detection.column)
  const jobId = crypto.randomUUID()

  await supabaseRequest('POST', 'validation_jobs', {
    id: jobId,
    filename: ingest.filename,
    total_rows: rows.length,
    processed_rows: 0,
    valid_count: 0,
    invalid_count: 0,
    status: 'pending',
    source: 'telegram',
    column_order: headers,
  })

  const validationRows = rows.map((row, i) => ({
    job_id: jobId,
    email: row[colIndex] ?? '',
    row_index: i,
    status: 'pending',
    row_data: Object.fromEntries(headers.map((h, hi) => [h, row[hi] ?? ''])),
  }))
  const CHUNK_SIZE = 500
  for (let i = 0; i < validationRows.length; i += CHUNK_SIZE) {
    await supabaseRequest('POST', 'validation_rows', validationRows.slice(i, i + CHUNK_SIZE))
  }

  await supabaseRequest('PATCH', `telegram_ingests?id=eq.${ingestId}`, { status: 'approved', validation_job_id: jobId })

  fetch(`${SUPABASE_URL}/functions/v1/email-validator`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ job_id: jobId }),
  }).catch(err => console.error('[telegram-inbox] email-validator invoke error:', err))

  await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Approved — running now.' })
  if (ingest.telegram_message_id) {
    await tg('editMessageText', {
      chat_id: ingest.telegram_chat_id,
      message_id: ingest.telegram_message_id,
      text: `✅ Approved — running — ${ingest.filename} (${rows.length} rows)`,
    })
  }
  await tg('sendMessage', { chat_id: ingest.sender_chat_id, text: 'Approved — running now.' })
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

  try {
    if (update.message?.document) {
      await handleDocument(update.message)
    } else if (update.callback_query) {
      await handleCallback(update.callback_query)
    }
    // All other update types (plain text, etc.) are silently ignored —
    // Telegram just needs a 200 regardless so it doesn't retry.
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[telegram-inbox] handler error:', message)
    await tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: `⚠️ telegram-inbox error: ${message}` }).catch(() => {})
  }

  return new Response('OK', { status: 200 })
})
