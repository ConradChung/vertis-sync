-- lume_alert_upsert: in reopen / update mode a given campaign_id / scope
-- replaces the stored one (a re-opened push_review can name a new campaign);
-- a null one, and touch mode, keep what is stored. Same signature and grants.
create or replace function lume_alert_upsert(
  p_source      text,
  p_severity    text,
  p_title       text,
  p_body        text,
  p_link        text,
  p_campaign_id text,
  p_scope       text,
  p_dedupe_key  text,
  p_mode        text default 'reopen'
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_id uuid;
  v_severity text := coalesce(p_severity, 'info');
begin
  if p_mode is null or p_mode not in ('reopen', 'update', 'touch') then
    raise exception 'lume_alert_upsert: unknown mode %', p_mode using errcode = '22023';
  end if;
  if p_dedupe_key is null then
    insert into lume_alerts (source, severity, title, body, link, campaign_id, scope)
    values (p_source, v_severity, p_title, p_body, p_link, p_campaign_id, p_scope)
    returning id into v_id;
    return v_id;
  end if;
  insert into lume_alerts as a (source, severity, title, body, link, campaign_id, scope, dedupe_key)
  values (p_source, v_severity, p_title, p_body, p_link, p_campaign_id, p_scope, p_dedupe_key)
  on conflict (dedupe_key) do update set
    source            = case when p_mode = 'touch' then a.source   else excluded.source   end,
    severity          = case when p_mode = 'touch' then a.severity else excluded.severity end,
    title             = case when p_mode = 'touch' then a.title    else excluded.title    end,
    body              = case when p_mode = 'touch' then a.body     else excluded.body     end,
    link              = case when p_mode = 'touch' then a.link     else coalesce(excluded.link, a.link) end,
    campaign_id       = case when p_mode = 'touch' then coalesce(a.campaign_id, excluded.campaign_id)
                             else coalesce(excluded.campaign_id, a.campaign_id) end,
    scope             = case when p_mode = 'touch' then coalesce(a.scope, excluded.scope)
                             else coalesce(excluded.scope, a.scope) end,
    acked_at          = case when p_mode = 'update' then a.acked_at          else null  end,
    acked_by_operator = case when p_mode = 'update' then a.acked_by_operator else null  end,
    created_at        = case when p_mode = 'update' then a.created_at        else now() end
  returning a.id into v_id;
  return v_id;
end $$;
revoke all on function lume_alert_upsert(text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function lume_alert_upsert(text, text, text, text, text, text, text, text, text) to service_role;
