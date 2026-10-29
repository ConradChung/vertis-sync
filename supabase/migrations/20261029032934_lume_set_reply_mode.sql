-- Inbox manager 3e fix: a reply-mode change and its audit event are one
-- transaction. lume_set_reply_mode(campaign, mode, by) locks the campaign's
-- row (creating it as 'owner' when missing), sets the mode, and when it
-- changed inserts the lume.reply_mode_changed event, then returns
-- {from, to, event_id}. Service role only (the route is owner-session only).
-- Also: lume_replies by lead address (the Auto grant checks a lead's earlier
-- labels in every campaign).

create or replace function public.lume_set_reply_mode(p_campaign_id text, p_mode text, p_by text)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
set lock_timeout = '2s'
as $$
declare
  v_from text;
  v_event bigint;
begin
  if p_mode not in ('owner', 'client', 'auto') then raise exception 'bad_mode'; end if;
  insert into lume_campaign_reply_modes (campaign_id) values (p_campaign_id) on conflict (campaign_id) do nothing;
  select mode into v_from from lume_campaign_reply_modes where campaign_id = p_campaign_id for update;
  if v_from = p_mode then
    return jsonb_build_object('from', v_from, 'to', p_mode, 'event_id', null);
  end if;
  update lume_campaign_reply_modes
     set mode = p_mode, updated_at = now(), updated_by = left(p_by, 120)
   where campaign_id = p_campaign_id;
  insert into events (type, source, source_id, campaign_id, title, payload)
    values ('lume.reply_mode_changed', 'lume', p_campaign_id, p_campaign_id,
            format('Reply mode for campaign %s: %s → %s', p_campaign_id, v_from, p_mode),
            jsonb_build_object('campaign_id', p_campaign_id, 'from', v_from, 'to', p_mode, 'by', left(p_by, 120)))
    returning id into v_event;
  return jsonb_build_object('from', v_from, 'to', p_mode, 'event_id', v_event);
end $$;
revoke all on function public.lume_set_reply_mode(text, text, text) from public, anon, authenticated;
grant execute on function public.lume_set_reply_mode(text, text, text) to service_role;

create index if not exists lume_replies_lead_email_idx on public.lume_replies (lead_email);
