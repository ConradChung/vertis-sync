-- Grok Bot operator sessions. Operators sign in as the owner's Supabase user,
-- so each /auth/operator sign-in records its session id (the JWT `session_id`
-- claim); revoking the operator deletes exactly those sessions (and, by FK
-- cascade, their refresh tokens), signing that bot out everywhere while the
-- owner's own sessions survive.
create table if not exists public.lume_operator_sessions (
  operator_id uuid not null references public.lume_operators(id) on delete cascade,
  session_id  uuid not null,
  created_at  timestamptz not null default now(),
  primary key (operator_id, session_id)
);
alter table public.lume_operator_sessions enable row level security;
revoke all on public.lume_operator_sessions from anon, authenticated;

-- Delete a revoked operator's Supabase sessions. Security definer (auth.sessions
-- is not reachable by service_role); executable by service_role only.
create or replace function public.lume_revoke_operator_sessions(op uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from auth.sessions s
   using public.lume_operator_sessions os
   where os.operator_id = op
     and s.id = os.session_id;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.lume_revoke_operator_sessions(uuid) from public, anon, authenticated;
grant execute on function public.lume_revoke_operator_sessions(uuid) to service_role;
