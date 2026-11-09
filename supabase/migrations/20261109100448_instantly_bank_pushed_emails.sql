-- instantly-push bank route: skip leads a previous push already created in Instantly (any job, any
-- campaign; validation_rows.instantly_status = 'pushed'), case-insensitively. Additive.
create index if not exists validation_rows_pushed_lower_email_idx
  on public.validation_rows (lower(email)) where instantly_status = 'pushed';

create or replace function public.instantly_pushed_emails(p_emails text[])
returns setof text
language sql
stable
set search_path = public, pg_catalog
as $$
  select distinct lower(r.email)
    from public.validation_rows r
   where r.instantly_status = 'pushed'
     and lower(r.email) = any (select lower(e) from unnest(p_emails) e);
$$;
revoke all on function public.instantly_pushed_emails(text[]) from public, anon, authenticated;
grant execute on function public.instantly_pushed_emails(text[]) to service_role;
