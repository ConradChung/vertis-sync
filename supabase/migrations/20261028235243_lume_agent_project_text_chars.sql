-- Length of the extracted text, so a run can pick the small items for the
-- Project block without fetching every file's full text.
alter table agent_project_files
  add column if not exists text_chars integer generated always as (coalesce(length(text_content), 0)) stored;
