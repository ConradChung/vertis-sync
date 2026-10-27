-- pgTAP: rotation_rules.kind / params (migration lume_cycle_out_rules).
begin;
select plan(10);
select has_column('public', 'rotation_rules', 'kind', 'kind exists');
select col_default_is('public', 'rotation_rules', 'kind', 'rotate', 'kind defaults to rotate');
select col_not_null('public', 'rotation_rules', 'params', 'params required');
select lives_ok($$insert into rotation_rules (id, name, campaign_id, cron) values ('00000000-0000-0000-0000-00000000c801', 'r', 'c', '0 8 * * *')$$,
  'a plain rotation rule still inserts');
select is((select kind || ':' || params::text from rotation_rules where id = '00000000-0000-0000-0000-00000000c801'), 'rotate:{}', 'defaults to rotate with {}');
select lives_ok($$insert into rotation_rules (name, campaign_id, cron, kind, params) values ('c', 'c', '0 7 * * *', 'cycle_out', '{"after_days":14,"refill_to":900}')$$,
  'a cycle_out rule with after_days and refill_to inserts');
select throws_ok($$insert into rotation_rules (name, campaign_id, cron, kind, params) values ('c', 'c', '0 7 * * *', 'cycle_out', '{}')$$,
  '23514', null, 'cycle_out needs after_days');
select throws_ok($$insert into rotation_rules (name, campaign_id, cron, kind, params) values ('c', 'c', '0 7 * * *', 'cycle_out', '{"after_days":0}')$$,
  '23514', null, 'after_days at least 1');
select throws_ok($$insert into rotation_rules (name, campaign_id, cron, kind, params) values ('c', 'c', '0 7 * * *', 'cycle_out', '{"after_days":14,"refill_to":"x"}')$$,
  '23514', null, 'refill_to must be a number');
select throws_ok($$insert into rotation_rules (name, campaign_id, cron, kind) values ('c', 'c', '0 7 * * *', 'purge')$$,
  '23514', null, 'unknown rule kinds are refused');
select * from finish();
rollback;
