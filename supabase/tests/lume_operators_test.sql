-- supabase/tests/lume_operators_test.sql
-- Grok Bot operator layer (Phase G1): verticals, operator keys, attribution.
begin;
select plan(29);

-- structure
select has_table('public', 'lume_verticals', 'lume_verticals exists');
select has_table('public', 'lume_operators', 'lume_operators exists');
select has_column('public', 'pending_actions', 'decided_by_operator', 'pending_actions.decided_by_operator exists');
select has_column('public', 'agent_conversations', 'vertical_id', 'agent_conversations.vertical_id exists');
select has_column('public', 'agent_conversations', 'operator_id', 'agent_conversations.operator_id exists');
select fk_ok('public', 'pending_actions', 'decided_by_operator', 'public', 'lume_operators', 'id', 'decided_by_operator references lume_operators');
select fk_ok('public', 'agent_conversations', 'vertical_id', 'public', 'lume_verticals', 'id', 'agent_conversations.vertical_id references lume_verticals');
select fk_ok('public', 'agent_conversations', 'operator_id', 'public', 'lume_operators', 'id', 'agent_conversations.operator_id references lume_operators');
select col_default_is('public', 'lume_verticals', 'is_default', 'false', 'lume_verticals.is_default defaults to false');
select col_default_is('public', 'lume_operators', 'is_master', 'false', 'lume_operators.is_master defaults to false');

-- RLS: on, no policies, nothing granted to anon / authenticated (service role only)
select ok((select relrowsecurity from pg_class where relname='lume_verticals'), 'lume_verticals has RLS on');
select ok((select relrowsecurity from pg_class where relname='lume_operators'), 'lume_operators has RLS on');
select ok(not has_table_privilege('authenticated', 'public.lume_operators', 'select'), 'authenticated cannot read lume_operators');
select ok(not has_table_privilege('anon', 'public.lume_verticals', 'select'), 'anon cannot read lume_verticals');

-- seed (20261027020633): the owner's five verticals, Kaspen / Zenport the default, idempotent
select is((select count(*)::int from lume_verticals where name in
  ('Job search / GTM roles','PM reactions','HNWI / wealth management','Kaspen / Zenport','Roofers')), 5, 'the five seeded verticals exist');
select is((select name from lume_verticals where is_default), 'Kaspen / Zenport', 'Kaspen / Zenport is the default vertical');
select lives_ok($$insert into lume_verticals (name, scopes, is_default) values ('Kaspen / Zenport', '{campaign}', true)
  on conflict (name) do nothing$$, 're-running the seed is a no-op');

-- behaviour: verticals
-- (clear any seeded default inside this rolled-back transaction)
update lume_verticals set is_default = false where is_default;
select lives_ok($$insert into lume_verticals (id, name, scopes, is_default) values
  ('00000000-0000-0000-0000-0000000e7101', 'pgtap vertical A', '{campaign,orders}', true)$$, 'a vertical with known scopes and the default flag inserts');
select throws_ok($$insert into lume_verticals (name, scopes) values ('pgtap bad scope', '{campaign,nope}')$$,
  '23514', null, 'lume_verticals.scopes rejects unknown scopes');
select throws_ok($$insert into lume_verticals (name, is_default) values ('pgtap second default', true)$$,
  '23505', null, 'only one vertical can be the default');
select throws_ok($$insert into lume_verticals (name) values ('pgtap vertical A')$$,
  '23505', null, 'vertical names are unique');

-- behaviour: operators (master <=> no vertical)
select lives_ok($$insert into lume_operators (id, vertical_id, label, key_hash) values
  ('00000000-0000-0000-0000-0000000e7201', '00000000-0000-0000-0000-0000000e7101', 'bot A', repeat('a', 64))$$, 'a vertical operator inserts');
select lives_ok($$insert into lume_operators (id, is_master, label, key_hash) values
  ('00000000-0000-0000-0000-0000000e7202', true, 'master', repeat('b', 64))$$, 'a master operator with no vertical inserts');
select throws_ok($$insert into lume_operators (is_master, label, key_hash) values (false, 'orphan', repeat('c', 64))$$,
  '23514', null, 'a non-master operator needs a vertical');
select throws_ok($$insert into lume_operators (vertical_id, is_master, label, key_hash) values
  ('00000000-0000-0000-0000-0000000e7101', true, 'master with vertical', repeat('d', 64))$$,
  '23514', null, 'a master operator cannot have a vertical');
select throws_ok($$insert into lume_operators (vertical_id, label, key_hash) values
  ('00000000-0000-0000-0000-0000000e7101', 'dup', repeat('a', 64))$$, '23505', null, 'key_hash is unique');
select throws_ok($$insert into lume_operators (vertical_id, label, key_hash) values
  ('00000000-0000-0000-0000-0000000e7101', 'raw key', 'not-a-sha256')$$, '23514', null, 'key_hash must be sha256 hex');

-- behaviour: attribution
select lives_ok($$insert into pending_actions (kind, decided_via, decided_by_operator) values
  ('pause_campaign', 'operator', '00000000-0000-0000-0000-0000000e7201')$$, 'pending_actions.decided_via accepts operator, with the deciding operator');
select throws_ok($$insert into pending_actions (kind, decided_via) values ('pause_campaign', 'nope')$$,
  '23514', null, 'pending_actions.decided_via still rejects unknown values');

select * from finish();
rollback;
