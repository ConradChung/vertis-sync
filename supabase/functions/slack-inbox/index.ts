// Supabase Edge Function: slack-inbox
// Slack is intake-only: a teammate shares a .csv in Slack, this function
// downloads it, stages it, and sends the SAME Approve/Approve+Enrich/Deny
// prompt to the owner's Telegram as the telegram-inbox flow. Approval still
// happens in Telegram; telegram-inbox's handleCallback replies back to Slack
// (via sender_platform='slack') once the owner decides.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID')!
const SLACK_BOT_TOKEN = Deno.env.get('SLACK_BOT_TOKEN')!
const SLACK_SIGNING_SECRET = Deno.env.get('SLACK_SIGNING_SECRET')!

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
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function slackApi(method: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function slackApiGet(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
  })
  return res.json()
}

async function verifySlackSignature(timestamp: string, rawBody: string, signature: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SLACK_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBase = `v0:${timestamp}:${rawBody}`
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(sigBase))
  const hex = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('')
  return `v0=${hex}` === signature
}

// ---- Compact CSV parsing (mirrors telegram-inbox / app/api/validate/start) ----

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

interface TelegramIngest { id: string }

async function handleFileShared(fileId: string, channelId: string): Promise<void> {
  const info = await slackApiGet('files.info', { file: fileId })
  const file = info.file as {
    name?: string
    url_private_download?: string
    user?: string
    filetype?: string
  } | undefined

  if (!info.ok || !file?.url_private_download) {
    console.error('[slack-inbox] files.info failed:', JSON.stringify(info))
    return
  }

  const name = file.name ?? 'upload.csv'
  if (!name.toLowerCase().endsWith('.csv')) {
    await slackApi('chat.postMessage', {
      channel: channelId,
      text: "Please share a .csv file — that's the only format I can check right now.",
    })
    return
  }

  const fileRes = await fetch(file.url_private_download, {
    headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
  })
  const csvText = await fileRes.text()
  const { headers, rows } = parseCSV(csvText)
  const detection = detectEmailColumn(headers)
  const detectedColumn = 'column' in detection ? detection.column : null

  const storagePath = `slack/${crypto.randomUUID()}.csv`
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
    await slackApi('chat.postMessage', { channel: channelId, text: 'Something went wrong saving your file — try again in a bit.' })
    return
  }

  let senderName = 'Unknown'
  if (file.user) {
    const userInfo = await slackApiGet('users.info', { user: file.user })
    const user = userInfo.user as { real_name?: string; name?: string } | undefined
    senderName = user?.real_name || user?.name || 'Unknown'
  }

  const ingestRows = (await supabaseRequest('POST', 'telegram_ingests', {
    telegram_chat_id: TELEGRAM_CHAT_ID,
    sender_chat_id: file.user ?? 'unknown',
    sender_name: senderName,
    sender_platform: 'slack',
    slack_channel_id: channelId,
    filename: name,
    storage_path: storagePath,
    row_count: rows.length,
    detected_email_column: detectedColumn,
    status: 'awaiting_approval',
  }, { returning: true })) as TelegramIngest[]
  const ingest = ingestRows[0]

  await slackApi('chat.postMessage', { channel: channelId, text: 'Got your file — checking with the owner. Hang tight.' })

  const columnLine = detectedColumn
    ? `Email column: ${detectedColumn}`
    : "⚠️ Couldn't confidently detect an email column — you'll need to handle this one via the dashboard."

  const ownerText = [
    `📥 New CSV from ${senderName} (Slack)`,
    `File: ${name}`,
    `Rows: ${rows.length}`,
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

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const rawBody = await req.text()
  const timestamp = req.headers.get('X-Slack-Request-Timestamp') ?? ''
  const signature = req.headers.get('X-Slack-Signature') ?? ''

  const validSig = await verifySlackSignature(timestamp, rawBody, signature)
  if (!validSig) {
    return new Response('Unauthorized', { status: 401 })
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  // Slack's one-time Request URL verification handshake.
  if (payload.type === 'url_verification') {
    return new Response(JSON.stringify({ challenge: payload.challenge }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (payload.type === 'event_callback') {
    const event = payload.event as { type?: string; file_id?: string; channel_id?: string } | undefined
    // Respond to Slack immediately (it retries on timeout); process after —
    // waitUntil keeps the function alive past the response like the other
    // edge functions in this app do.
    if (event?.type === 'file_shared' && event.file_id && event.channel_id) {
      EdgeRuntime.waitUntil(
        handleFileShared(event.file_id, event.channel_id).catch(err =>
          console.error('[slack-inbox] handleFileShared error:', err instanceof Error ? err.message : String(err)),
        ),
      )
    }
  }

  return new Response('', { status: 200 })
})
