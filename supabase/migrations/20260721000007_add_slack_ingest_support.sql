alter table telegram_ingests
  add column if not exists sender_platform text not null default 'telegram'
    check (sender_platform in ('telegram', 'slack')),
  add column if not exists slack_channel_id text,
  add column if not exists slack_message_ts text;
