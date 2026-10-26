-- pgTAP: run_actor pending-action kind (migration lume_run_actor_kind).
begin;
select plan(4);
insert into public.pending_actions(kind, payload, requested_by)
  values ('run_actor', '{"summary":"t","input_hash":"h1"}', 'agent');
select pass('run_actor is an allowed kind');
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('run_actor', '{"summary":"t","input_hash":"h1"}', 'agent')$$,
  '23505', null, 'a second awaiting run_actor with the same input_hash is refused');
select lives_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('run_actor', '{"summary":"t","input_hash":"h2"}', 'agent')$$,
  'a different input_hash is allowed');
select throws_ok(
  $$insert into public.pending_actions(kind, payload, requested_by) values ('bogus_kind', '{"summary":"t"}', 'agent')$$,
  '23514', null, 'unknown kinds are still refused');
select * from finish();
rollback;
