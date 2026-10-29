-- Inbox manager 3a–3c (docs/lume/2026-10-28-inbox-manager-design.md).
--
-- 1. One reply per inbound message: at most one send_reply per reply_to_uuid
--    that is awaiting, approved, executing or executed. A failed, denied or
--    expired one does not block a new draft. (The older awaiting-only
--    pending_actions_one_awaiting_reply_idx stays; this one is wider.)
-- 2. lume_replies: positive inbound replies (Instantly webhook or the
--    list_replies poll), one row per inbound message, for /operator's
--    "New replies" section and its handled state. Service role only.
-- 3. lume_project_append_line(project, name, line): the bot API's
--    append-rule. Appends one line to the newest note of that name in the
--    project (name match ignores case), creating the note when missing, under
--    a per-(project, name) advisory lock so two appends never lose a line.
--    An uploaded file of that name is never rewritten (not_a_note).

create unique index pending_actions_one_reply_per_inbound_idx
  on public.pending_actions ((payload ->> 'reply_to_uuid'))
  where kind = 'send_reply' and status in ('awaiting', 'approved', 'executing', 'executed');

create table public.lume_replies (
  reply_to_uuid text primary key check (length(btrim(reply_to_uuid)) between 1 and 200),
  campaign_id text,
  lead_email text not null check (length(lead_email) <= 320),
  lead_name text check (lead_name is null or length(lead_name) <= 300),
  company text check (company is null or length(company) <= 300),
  eaccount text check (eaccount is null or length(eaccount) <= 320),
  subject text check (subject is null or length(subject) <= 500),
  thread_id text check (thread_id is null or length(thread_id) <= 200),
  excerpt text check (excerpt is null or length(excerpt) <= 2000),
  interest smallint,
  source text not null check (source in ('webhook', 'poll')),
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  handled_how text check (handled_how is null or length(handled_how) <= 80),
  handled_action_id uuid
);
create index lume_replies_open_idx on public.lume_replies (received_at desc) where handled_at is null;
create index lume_replies_lead_idx on public.lume_replies (campaign_id, lead_email);
alter table public.lume_replies enable row level security;
revoke all on public.lume_replies from anon, authenticated;

create or replace function public.lume_project_append_line(p_project uuid, p_name text, p_line text)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
set lock_timeout = '2s'
as $$
declare
  v_name text := btrim(p_name);
  v_line text := btrim(regexp_replace(p_line, '[\r\n]+', ' ', 'g'));
  v_item record;
  v_text text;
begin
  if v_name = '' or length(v_name) > 120 then raise exception 'bad_name'; end if;
  if v_line = '' or length(v_line) > 1000 then raise exception 'bad_line'; end if;
  if not exists (select 1 from agent_projects where id = p_project and archived_at is null) then
    raise exception 'project_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('lume_append:' || p_project::text || ':' || lower(v_name)));

  select id, kind, text_content into v_item
    from agent_project_files
   where project_id = p_project and lower(btrim(name)) = lower(v_name)
   order by created_at desc, id desc
   limit 1;

  if not found then
    insert into agent_project_files (project_id, kind, name, mime, size_bytes, text_content)
      values (p_project, 'note', v_name, 'text/plain', octet_length(v_line), v_line)
      returning id into v_item;
    return jsonb_build_object('id', v_item.id, 'name', v_name, 'created', true, 'chars', length(v_line));
  end if;
  if v_item.kind <> 'note' then raise exception 'not_a_note'; end if;

  v_text := case when coalesce(v_item.text_content, '') ~ '^\s*$' then v_line
                 else rtrim(v_item.text_content, E'\r\n') || E'\n' || v_line end;
  if length(v_text) > 200000 then raise exception 'note_full'; end if;
  update agent_project_files set text_content = v_text, size_bytes = octet_length(v_text) where id = v_item.id;
  return jsonb_build_object('id', v_item.id, 'name', v_name, 'created', false, 'chars', length(v_text));
end $$;
revoke all on function public.lume_project_append_line(uuid, text, text) from public, anon, authenticated;
grant execute on function public.lume_project_append_line(uuid, text, text) to service_role;
