# Telegram CSV Intake + Approval Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a friend send a CSV directly to the existing Telegram bot; the owner gets an Approve/Deny prompt in their own chat; only on approval does the file enter the existing email-validation pipeline (no manual download/upload by the owner).

**Architecture:** One new Supabase Edge Function, `telegram-inbox` (`verify_jwt: false`, since Telegram webhooks aren't JWT-authenticated — authenticity is instead checked via a `secret_token` Telegram echoes back on every call). It handles two Telegram update shapes: incoming documents (intake) and button taps (`callback_query`, approve/deny). On approval it creates `validation_jobs`/`validation_rows` exactly the way Phase 1 fixed (`row_data` + `column_order`, full columns preserved) and invokes the existing `email-validator` function unchanged. A new `telegram_ingests` table holds pre-approval state so unapproved/rejected uploads never show up in the dashboard.

**Tech Stack:** Deno (Supabase Edge Functions), Telegram Bot API (raw HTTP, no SDK — matches how `email-validator` calls Telegram today), direct PostgREST calls (no npm client, matching existing edge functions).

**Note on scope:** this replaces the originally-planned generic `x-api-key` `/api/validate/direct` endpoint (see `docs/plans/2026-07-21-telegram-csv-approval-design.md` for why). The `lib/validation/ingest.ts` extraction from the original Phase 2 spec is skipped too — nothing in this plan needs it, and it would be an abstraction with no second caller.

Design reference: `docs/plans/2026-07-21-telegram-csv-approval-design.md`

---

## Task 1: Database migration — `telegram_ingests` table

**Files:**
- Create: `supabase/migrations/20260721000003_create_telegram_ingests.sql`

**Step 1: Write the migration**

```sql
create table if not exists telegram_ingests (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id text not null,
  telegram_message_id bigint,
  sender_chat_id text not null,
  sender_name text,
  filename text not null,
  storage_path text not null,
  row_count int,
  detected_email_column text,
  status text not null default 'awaiting_approval'
    check (status in ('awaiting_approval', 'approved', 'rejected', 'error')),
  validation_job_id uuid references validation_jobs(id),
  created_at timestamptz not null default now()
);
```

**Step 2: Apply it**

Use the Supabase MCP `apply_migration` tool against project `rcfrumrbauwvyzfebxck` with `name: create_telegram_ingests`.

**Step 3: Verify**

Query `select column_name, data_type from information_schema.columns where table_name = 'telegram_ingests' order by ordinal_position;` via the Supabase MCP `execute_sql` tool — confirm all 11 columns exist with the right types, and that the `status` check constraint is present (`select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'telegram_ingests'::regclass;`).

**Step 4: Commit**

```bash
cd /Users/conradchung/vertis-sync
git add supabase/migrations/20260721000003_create_telegram_ingests.sql
git commit -m "feat: add telegram_ingests table for CSV approval flow"
```

---

## Task 2: `telegram-inbox` edge function

**Files:**
- Create: `supabase/functions/telegram-inbox/index.ts`

**Step 1: Write the complete function**

```typescript
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
    await tg('sendMessage', { chat_id: senderChatId, text: 'Could not read that file — try sending it again.' })
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
    console.error('[telegram-inbox] handler error:', err instanceof Error ? err.message : String(err))
  }

  return new Response('OK', { status: 200 })
})
```

**Step 2: Deploy**

Use the Supabase MCP `deploy_edge_function` tool: `project_id: rcfrumrbauwvyzfebxck`, `name: telegram-inbox`, `entrypoint_path: index.ts`, `verify_jwt: false` (this function must accept unauthenticated calls from Telegram — the `X-Telegram-Bot-Api-Secret-Token` check inside the function is the real auth), `files: [{ name: "index.ts", content: <the file above> }]`.

**Step 3: Verify it deployed**

Call the Supabase MCP `list_edge_functions` tool, confirm `telegram-inbox` is `ACTIVE` with `verify_jwt: false`.

**Step 4: Commit**

```bash
cd /Users/conradchung/vertis-sync
git add supabase/functions/telegram-inbox/index.ts
git commit -m "feat: add telegram-inbox edge function for CSV intake + approval"
```

---

## Task 3: Secrets + webhook registration

**Step 1: Generate the webhook secret**

`openssl rand -hex 24` — this is a value I mint myself, not a third-party credential.

**Step 2: Set it as a Supabase Edge Function secret**

No Supabase MCP tool sets secrets. Ask the user to add `TELEGRAM_WEBHOOK_SECRET` (the value from Step 1) via Supabase Dashboard → Project Settings → Edge Functions → Secrets, same as they'll do for `PERPLEXITY_API_KEY`/`ANTHROPIC_API_KEY` in Phase 3. Confirm once done.

**Step 3: Register the webhook with Telegram**

Using the bot token already provided in this conversation and the secret from Step 1 — run directly via Bash, do not write either value to any file:

```bash
curl -s -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://rcfrumrbauwvyzfebxck.supabase.co/functions/v1/telegram-inbox","secret_token":"<GENERATED_SECRET>"}'
```

Expected: `{"ok":true,"result":true,"description":"Webhook was set"}`

**Step 4: Verify webhook registration**

```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Expected: `url` matches the function URL, `last_error_message` absent.

No commit — this task is pure configuration, no files change.

---

## Task 4: DB-level verification of the approve/deny path

Since only a real Telegram client can generate a genuine incoming "friend sent a document" update (the Bot API has no way to fabricate that), this task verifies the parts that *can* be exercised directly: seed a `telegram_ingests` row pointing at a real CSV already in Storage, then POST a synthetic `callback_query` update straight at the deployed function (with the correct secret header) to exercise the exact same approve/deny code path Telegram would trigger.

**Step 1: Upload a test CSV and seed an ingest row**

Reuse the same 10-row/5-column test CSV from Phase 1 (`phase1_test.csv` in the scratchpad). Upload it to `raw-uploads/telegram/<uuid>.csv` via service-role `curl`, then insert a matching `telegram_ingests` row via the Supabase MCP `execute_sql` tool with `status: 'awaiting_approval'`, a real `sender_chat_id` you control (or a throwaway numeric string if just checking DB state, not the Telegram message send), and `detected_email_column: 'email'`.

**Step 2: Simulate the Approve tap**

```bash
curl -s -X POST "https://rcfrumrbauwvyzfebxck.supabase.co/functions/v1/telegram-inbox" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: <GENERATED_SECRET>" \
  -d '{"callback_query":{"id":"test1","from":{"id":1,"first_name":"Test"},"data":"approve:<INGEST_ID>"}}'
```

**Step 3: Verify**

Query `telegram_ingests` (status should be `approved`, `validation_job_id` set) and `validation_jobs`/`validation_rows` for the new job via the Supabase MCP `execute_sql` tool — confirm `row_data`/`column_order` are populated exactly like Phase 1's verified output. Poll `/api/validate/status` until `completed`, download via `/api/validate/results`, confirm 5 columns and correct row count (same check as Phase 1).

**Step 4: Simulate Deny on a second seeded row**

Repeat Steps 1–2 with `action=deny`, confirm `telegram_ingests.status = 'rejected'` and the raw upload is deleted from Storage.

**Step 5: Clean up test data**

Delete the test `validation_jobs`/`telegram_ingests` rows and any leftover Storage objects, same pattern as Phase 1's cleanup.

No commit — verification only, no files change.

---

## Task 5: Real end-to-end confirmation (manual, by the user)

This is the one step that needs a real Telegram client, since a genuine "incoming document" update can't be fabricated.

1. From your own Telegram (playing the "friend" role, or ask an actual friend), send a real `.csv` file to the bot.
2. Confirm you receive: an acknowledgment in that chat, and an Approve/Deny prompt in your own owner chat with correct filename/row count/detected column.
3. Tap Approve. Confirm: your prompt message updates to "✅ Approved — running", the sender gets an "Approved" message, and the job appears on the dashboard's Previous Runs with the correct row/column count once `email-validator` finishes.
4. Optionally repeat with Deny to confirm that path too.

No code changes in this task — sign-off only.
