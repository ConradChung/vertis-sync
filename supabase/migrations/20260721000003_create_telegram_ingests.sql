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
