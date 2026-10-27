-- supabase/tests/lume_operator_sessions_test.sql
-- Grok Bot operator sessions: revoking an operator kills its Supabase sessions;
-- the Job search vertical owns muse:auto-apply.
begin;
select plan(22);

-- structure
select has_table('public', 'lume_operator_sessions', 'lume_operator_sessions exists');
select fk_ok('public', 'lume_operator_sessions', 'operator_id', 'public', 'lume_operators', 'id', 'lume_operator_sessions.operator_id references lume_operators');
select col_not_null('public', 'lume_operator_sessions', 'session_id', 'session_id is required');
select col_type_is('public', 'lume_operator_sessions', 'session_id', 'uuid', 'session_id is a uuid');
select ok((select relrowsecurity from pg_class where oid = 'public.lume_operator_sessions'::regclass), 'lume_operator_sessions has RLS on');
select ok(not has_table_privilege('authenticated', 'public.lume_operator_sessions', 'select'), 'authenticated cannot read lume_operator_sessions');
select ok(not has_table_privilege('anon', 'public.lume_operator_sessions', 'select'), 'anon cannot read lume_operator_sessions');

-- the revoke function: security definer, pinned search_path, service_role only
select has_function('public', 'lume_revoke_operator_sessions', array['uuid'], 'lume_revoke_operator_sessions(uuid) exists');
select is_definer('public', 'lume_revoke_operator_sessions', array['uuid'], 'it is security definer');
select ok((select proconfig::text like '%search_path=%' from pg_proc where oid = 'public.lume_revoke_operator_sessions(uuid)'::regprocedure), 'it pins search_path');
select ok(has_function_privilege('service_role', 'public.lume_revoke_operator_sessions(uuid)', 'execute'), 'service_role can execute it');
select ok(not has_function_privilege('authenticated', 'public.lume_revoke_operator_sessions(uuid)', 'execute'), 'authenticated cannot execute it');
select ok(not has_function_privilege('anon', 'public.lume_revoke_operator_sessions(uuid)', 'execute'), 'anon cannot execute it');

-- behaviour: two operators on the owner's user, one session each (plus a refresh token)
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000e7301', 'authenticated', 'authenticated', 'pgtap-op-sessions@example.com');
insert into lume_verticals (id, name, scopes) values ('00000000-0000-0000-0000-0000000e7311', 'pgtap sessions vertical', '{campaign}');
insert into lume_operators (id, vertical_id, label, key_hash) values
  ('00000000-0000-0000-0000-0000000e7321', '00000000-0000-0000-0000-0000000e7311', 'bot one', repeat('e', 64)),
  ('00000000-0000-0000-0000-0000000e7322', '00000000-0000-0000-0000-0000000e7311', 'bot two', repeat('f', 64));
insert into auth.sessions (id, user_id) values
  ('00000000-0000-0000-0000-0000000e7331', '00000000-0000-0000-0000-0000000e7301'),
  ('00000000-0000-0000-0000-0000000e7332', '00000000-0000-0000-0000-0000000e7301');
insert into auth.refresh_tokens (token, user_id, session_id, revoked) values
  ('pgtap-rt-one', '00000000-0000-0000-0000-0000000e7301', '00000000-0000-0000-0000-0000000e7331', false);

select lives_ok($$insert into lume_operator_sessions (operator_id, session_id) values
  ('00000000-0000-0000-0000-0000000e7321', '00000000-0000-0000-0000-0000000e7331'),
  ('00000000-0000-0000-0000-0000000e7322', '00000000-0000-0000-0000-0000000e7332')$$, 'operator sign-ins record their session ids');
select throws_ok($$insert into lume_operator_sessions (operator_id, session_id) values
  ('00000000-0000-0000-0000-0000000e7321', '00000000-0000-0000-0000-0000000e7331')$$, '23505', null, 'a session is recorded once per operator');

select is(public.lume_revoke_operator_sessions('00000000-0000-0000-0000-0000000e7321'), 1, 'revoking bot one deletes its one session');
select ok(not exists (select 1 from auth.sessions where id = '00000000-0000-0000-0000-0000000e7331'), 'bot one''s session is gone');
select ok(not exists (select 1 from auth.refresh_tokens where token = 'pgtap-rt-one'), 'its refresh token is gone with it');
select ok(exists (select 1 from auth.sessions where id = '00000000-0000-0000-0000-0000000e7332'), 'bot two''s session is untouched');
select is(public.lume_revoke_operator_sessions('00000000-0000-0000-0000-0000000e7321'), 0, 'revoking again is a no-op');

-- seed (muse:auto-apply → Job search / GTM roles), idempotent
select ok((select 'muse:auto-apply' = any(campaign_ids) from lume_verticals where name = 'Job search / GTM roles'), 'Job search / GTM roles owns muse:auto-apply');
select is((select count(*)::int from lume_verticals v, unnest(v.campaign_ids) c where c = 'muse:auto-apply'), 1, 'muse:auto-apply is mapped exactly once');

select * from finish();
rollback;
