-- supabase/tests/lume_agent_projects_test.sql
-- Agent projects: folders of conversations + knowledge (instructions, files, notes),
-- optionally linked to one vertical.
begin;
select plan(30);

-- structure
select has_table('public', 'agent_projects', 'agent_projects exists');
select has_table('public', 'agent_project_files', 'agent_project_files exists');
select has_column('public', 'agent_conversations', 'project_id', 'agent_conversations.project_id exists');
select fk_ok('public', 'agent_conversations', 'project_id', 'public', 'agent_projects', 'id', 'conversations reference projects');
select fk_ok('public', 'agent_project_files', 'project_id', 'public', 'agent_projects', 'id', 'files reference projects');
select fk_ok('public', 'agent_projects', 'vertical_id', 'public', 'lume_verticals', 'id', 'projects reference verticals');
select col_not_null('public', 'agent_projects', 'name', 'name is required');
select col_not_null('public', 'agent_projects', 'position', 'position is required');
select col_is_null('public', 'agent_project_files', 'storage_path', 'storage_path is nullable (notes)');

-- RLS + grants (service role only, like agent_conversations)
select ok((select relrowsecurity from pg_class where oid = 'public.agent_projects'::regclass), 'agent_projects has RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.agent_project_files'::regclass), 'agent_project_files has RLS on');
select ok(not has_table_privilege('authenticated', 'public.agent_projects', 'select'), 'authenticated cannot read agent_projects');
select ok(not has_table_privilege('anon', 'public.agent_projects', 'select'), 'anon cannot read agent_projects');
select ok(not has_table_privilege('authenticated', 'public.agent_project_files', 'select'), 'authenticated cannot read agent_project_files');
select ok(not has_table_privilege('anon', 'public.agent_project_files', 'insert'), 'anon cannot write agent_project_files');

-- storage bucket
select ok((select not public from storage.buckets where id = 'agent-projects'), 'agent-projects bucket exists and is private');

-- behaviour
insert into lume_verticals (id, name) values
  ('00000000-0000-0000-0000-0000000a9011', 'pgtap projects vertical'),
  ('00000000-0000-0000-0000-0000000a9012', 'pgtap projects vertical two');
insert into agent_projects (id, name, vertical_id, position) values
  ('00000000-0000-0000-0000-0000000a9021', 'pgtap Roofers', '00000000-0000-0000-0000-0000000a9011', 0);

select throws_ok($$insert into agent_projects (name) values ('PGTAP roofers')$$, '23505', null, 'names are unique among live projects (case-insensitive)');
select throws_ok($$insert into agent_projects (name, vertical_id) values ('pgtap other', '00000000-0000-0000-0000-0000000a9011')$$, '23505', null, 'a vertical links to at most one live project');
select throws_ok($$insert into agent_projects (name) values ('   ')$$, '23514', null, 'a blank name is rejected');

update agent_projects set archived_at = now() where id = '00000000-0000-0000-0000-0000000a9021';
select lives_ok($$insert into agent_projects (id, name, vertical_id) values ('00000000-0000-0000-0000-0000000a9022', 'pgtap Roofers', '00000000-0000-0000-0000-0000000a9011')$$,
  'an archived project frees its name and its vertical');

select throws_ok($$insert into agent_project_files (project_id, kind, name, storage_path) values ('00000000-0000-0000-0000-0000000a9022', 'note', 'n', 'x/y.txt')$$,
  '23514', null, 'a note has no storage path');
select throws_ok($$insert into agent_project_files (project_id, kind, name) values ('00000000-0000-0000-0000-0000000a9022', 'file', 'f.csv')$$,
  '23514', null, 'a file has a storage path');
select throws_ok($$insert into agent_project_files (project_id, kind, name, text_content) values ('00000000-0000-0000-0000-0000000a9022', 'note', 'big', repeat('x', 200001))$$,
  '23514', null, 'stored text is capped at 200k chars');
select throws_ok($$insert into agent_project_files (project_id, kind, name, size_bytes, storage_path) values ('00000000-0000-0000-0000-0000000a9022', 'file', 'huge.pdf', 20971521, 'p/huge.pdf')$$,
  '23514', null, 'a file is capped at 20 MB');

insert into agent_project_files (id, project_id, kind, name, text_content) values
  ('00000000-0000-0000-0000-0000000a9031', '00000000-0000-0000-0000-0000000a9022', 'note', 'tone', 'casual');
insert into agent_conversations (id, title, project_id) values
  ('00000000-0000-0000-0000-0000000a9041', 'pgtap filed chat', '00000000-0000-0000-0000-0000000a9022');

delete from agent_projects where id = '00000000-0000-0000-0000-0000000a9022';
select ok(exists (select 1 from agent_conversations where id = '00000000-0000-0000-0000-0000000a9041'), 'deleting a project keeps its chats');
select is((select project_id from agent_conversations where id = '00000000-0000-0000-0000-0000000a9041'), null::uuid, 'its chats move to Unfiled (set null)');
select ok(not exists (select 1 from agent_project_files where id = '00000000-0000-0000-0000-0000000a9031'), 'its files and notes go with it');

insert into agent_projects (id, name, vertical_id) values ('00000000-0000-0000-0000-0000000a9023', 'pgtap linked', '00000000-0000-0000-0000-0000000a9011');
select lives_ok($$delete from agent_projects where id = '00000000-0000-0000-0000-0000000a9021'$$, 'an archived project can be removed');
select lives_ok($$update agent_projects set vertical_id = null where id = '00000000-0000-0000-0000-0000000a9023'$$, 'a project can be unlinked');
select is((select count(*)::int from agent_projects where name like 'pgtap%'), 1, 'one pgtap project left');

select * from finish();
rollback;
