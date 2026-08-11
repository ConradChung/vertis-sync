create table if not exists pipeline_watchdog_state (
  job_id uuid primary key,
  last_done int not null,
  checked_at timestamptz not null default now(),
  revives int not null default 0
);

create or replace function public.pipeline_watchdog() returns void
language plpgsql security definer as $$
declare
  j record; fn text; done int; key text; url text;
begin
  select decrypted_secret into key from vault.decrypted_secrets where name='service_role_key';
  select decrypted_secret into url from vault.decrypted_secrets where name='project_url';
  if key is null or url is null then return; end if;

  for j in
    select id from validation_jobs where status in ('pending','processing')
  loop
    -- Which stage should be running? Blank-email rows go to the finder first.
    if exists (select 1 from validation_rows r
               where r.job_id=j.id and r.status='pending' and r.email='') then
      fn := 'contact-email-finder';
      select count(*) into done from validation_rows r
        where r.job_id=j.id and r.status in ('no_email','valid','invalid','error');
    elsif exists (select 1 from validation_rows r
                  where r.job_id=j.id and r.status='pending') then
      fn := 'email-validator';
      select count(*) into done from validation_rows r
        where r.job_id=j.id and r.status<>'pending';
    else
      delete from pipeline_watchdog_state where job_id=j.id;
      continue;  -- nothing pending; the stage will finish on its own
    end if;

    -- Only revive when progress has not moved since the previous tick, so a
    -- healthy run is never disturbed by a duplicate invocation.
    if exists (select 1 from pipeline_watchdog_state s
               where s.job_id=j.id and s.last_done=done) then
      perform net.http_post(
        url := url || '/functions/v1/' || fn,
        headers := jsonb_build_object('Content-Type','application/json',
                                      'Authorization','Bearer '||key,'apikey',key),
        body := jsonb_build_object('job_id', j.id)
      );
      update pipeline_watchdog_state
        set checked_at=now(), revives=revives+1 where job_id=j.id;
    else
      insert into pipeline_watchdog_state(job_id,last_done)
      values (j.id,done)
      on conflict (job_id) do update set last_done=excluded.last_done, checked_at=now();
    end if;
  end loop;
end $$;

select cron.unschedule('pipeline-watchdog') where exists (
  select 1 from cron.job where jobname='pipeline-watchdog');
select cron.schedule('pipeline-watchdog','*/5 * * * *','select public.pipeline_watchdog()');
