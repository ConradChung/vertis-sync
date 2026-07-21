# Telegram CSV Intake + Approval Flow

**Date:** 2026-07-21
**Status:** Approved

## Overview

Replaces Phase 2's originally-planned generic `x-api-key` `/api/validate/direct` endpoint with a concrete use case: a friend sends a CSV directly to the existing Telegram bot, the owner gets an Approve/Deny prompt in their own chat, and only on approval does the file enter the normal email-validation pipeline (the one Phase 1 fixed to preserve all columns). No manual download-and-upload step for the owner.

Out of scope for this pass: the generic API-key endpoint from the original Phase 2 spec (deferred until an actual automated caller needs it), sending the sender the finished CSV (sender only learns receipt + approve/deny, never results or files), and any sender allowlist (the approval tap is the only gate — anyone can send, nothing runs without the owner's approval).

---

## Architecture

```
Friend (Telegram DM to bot)
      │ sends .csv document
      ▼
supabase/functions/telegram-inbox      ← new edge function, verify_jwt: false
  - Verifies X-Telegram-Bot-Api-Secret-Token header (Telegram echoes the
    secret_token registered via setWebhook — this is the request's only
    authenticity check, since verify_jwt is off)
  - Downloads the file from the Telegram Bot API, uploads raw bytes to
    Storage (raw-uploads/telegram/<uuid>.csv)
  - Light parse: header row + row count + email-column detection
    (compact reimplementation of normalizeHeader/detectEmailColumn —
    edge functions don't share code with the Next.js app, matching how
    email-validator is already self-contained)
  - Inserts telegram_ingests row (status: awaiting_approval)
  - Replies to the friend: "Got your file — checking with the owner."
  - Messages the owner (existing TELEGRAM_CHAT_ID secret) with sender
    name, filename, row count, detected email column, and an inline
    keyboard: [✅ Approve] [❌ Deny]
      │
      │ owner taps a button → Telegram sends callback_query
      ▼
supabase/functions/telegram-inbox      ← same function, callback_query branch
  Approve:
    - Re-downloads + fully parses the stored CSV
    - Creates validation_jobs (source: 'telegram', column_order) +
      chunked validation_rows (row_data, 500/batch) — same shape Phase 1
      already fixed
    - Invokes email-validator with the new job_id (existing pattern)
    - Updates telegram_ingests (status: approved, validation_job_id)
    - Edits the owner's message to "✅ Approved — running"
    - Tells the friend: "Approved."
  Deny:
    - Updates telegram_ingests (status: rejected)
    - Deletes the raw upload from Storage
    - Edits the owner's message to "❌ Denied"
    - Tells the friend: "Not approved right now."
      │
      ▼
email-validator (existing, unchanged) → validates, uploads valid.csv,
  sends the existing milestone/completion Telegram messages to the owner
  (sender is not included in this — matches "silent to sender" for results)
```

If the email column can't be confidently detected during intake, the owner's message shows only [❌ Deny] with a note to handle it via the dashboard instead — the bot only automates the happy path.

---

## Database Changes

New table, deliberately separate from `validation_jobs` so unapproved/rejected uploads never appear in the dashboard's Previous Runs:

```sql
create table if not exists telegram_ingests (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id text not null,        -- owner's chat (where the prompt was sent)
  telegram_message_id bigint,            -- owner's prompt message (to edit after decision)
  sender_chat_id text not null,          -- friend's chat (to reply to them)
  sender_name text,
  filename text not null,
  storage_path text not null,            -- raw upload in Storage, pre-approval
  row_count int,
  detected_email_column text,
  status text not null default 'awaiting_approval'
    check (status in ('awaiting_approval', 'approved', 'rejected', 'error')),
  validation_job_id uuid references validation_jobs(id),
  created_at timestamptz not null default now()
);
```

---

## Security

- **Webhook authenticity:** Telegram's `setWebhook` supports a `secret_token` param; Telegram echoes it back as `X-Telegram-Bot-Api-Secret-Token` on every call. The function rejects any request where this doesn't match a new `TELEGRAM_WEBHOOK_SECRET` edge function secret. Without this, the public function URL would accept forged updates from anyone.
- **Approval gate:** only the owner's own Telegram chat (`TELEGRAM_CHAT_ID`, already an existing secret) ever receives the Approve/Deny buttons — that chat membership is the access control, not a sender allowlist.
- **Bot token:** `TELEGRAM_BOT_TOKEN` already exists as a Supabase secret (used today for outbound milestone messages) — reused as-is, no new secret needed for it.
- **One-time setup:** registering the webhook (`setWebhook` call) is done once by the repo owner directly against the Telegram API, not scripted with the token passed through the assistant.

---

## Environment Variables (new)

| Variable | Where | Purpose |
|---|---|---|
| `TELEGRAM_WEBHOOK_SECRET` | Supabase Edge Function secret | Verifies inbound webhook calls actually came from Telegram |

No Vercel env vars needed — this entire feature lives in Supabase Edge Functions, reusing `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` already present there.

---

## Error Handling / Edge Cases

- Non-document messages, or documents not ending in `.csv`: bot replies asking the sender to send a `.csv` file directly.
- Ambiguous/undetectable email column: owner sees a warning, only Deny is offered.
- Double-tap on an already-resolved approval (`status != 'awaiting_approval'`): `answerCallbackQuery` with "Already handled," no side effects repeated.
- Telegram Bot API file size limit (20MB) is Telegram's own constraint — not re-implemented here.

---

## Dependency Note for Phase 3

The original Phase 3 spec assumes `/api/validate/direct` exists (`enrich: true` triggers `operating-city-enricher` instead of `email-validator`). Since that generic endpoint isn't being built now, Phase 3 will need to hook enrichment into this Telegram approval path instead (e.g., an "Approve + Enrich" button, or enrichment as a per-sender default) — to be resolved when Phase 3 is planned, not blocking this design.
