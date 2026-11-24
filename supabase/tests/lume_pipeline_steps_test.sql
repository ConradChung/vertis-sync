-- supabase/tests/lume_pipeline_steps_test.sql
-- GTM-18: lume_step_label() and the portal call-sheet view. Everything rolls back.
begin;
select plan(9);

select is(lume_step_label(1), '1 · Imported', 'step 1 label');
select is(lume_step_label(2), '2 · Combined', 'step 2 label');
select is(lume_step_label(3, 'excluded:   vendor '), '3 · Filtered — excluded: vendor', 'a note follows the name, whitespace squashed');
select is(lume_step_label(5, '  '), '5 · In campaign', 'a blank note is dropped');
select is(lume_step_label(9), '1 · Imported', 'out of range falls back to step 1');

insert into lead_review_sets (id, title, source_kind, source_id, kind)
  values ('00000000-0000-0000-0000-0000000018a1', 'GTM-18 Maps test', 'list', 'list', 'list');
insert into lead_review_items (set_id, idx, item, cells, status)
  values ('00000000-0000-0000-0000-0000000018a1', 0, '{"company":"Acme PM","phone":"(310) 555-0101","rating":4.6}', '{}', 'kept'),
         ('00000000-0000-0000-0000-0000000018a1', 1, '{}', '{"title":"Beta Mgmt","phoneUnformatted":"+13105550102","totalScore":"4.1"}', 'kept');
insert into lead_review_items (set_id, idx, item, cells, status, pipeline_step, step_note)
  values ('00000000-0000-0000-0000-0000000018a1', 2, '{"company":"Gone"}', '{}', 'excluded', 3, 'excluded: vendor');

select is((select pipeline_step::int from lead_review_items where set_id = '00000000-0000-0000-0000-0000000018a1' and idx = 0), 1, 'new rows start at step 1');
select is((select count(*)::int from lume_portal_sheet_leads where set_id = '00000000-0000-0000-0000-0000000018a1'), 2, 'excluded rows stay out of the call sheet');
select is((select phone from lume_portal_sheet_leads where set_id = '00000000-0000-0000-0000-0000000018a1' and company_name = 'Beta Mgmt'), '+13105550102', 'phone and business name fall back to the sheet cells');
select is((select step_label from lume_portal_sheet_leads where set_id = '00000000-0000-0000-0000-0000000018a1' and company_name = 'Acme PM'), '1 · Imported', 'the view carries the status label');

select * from finish();
rollback;
