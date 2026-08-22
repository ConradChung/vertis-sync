-- 1. Stop the April job the watchdog wrongly revived.
update validation_rows set status='error',
  validation_result=jsonb_build_object('error','cancelled: stale job revived in error by watchdog')
where job_id='7db3d841-252c-4572-95ec-bc110727df8d' and status='pending';

update validation_jobs set status='cancelled',
  error_message='Stale April job; revived in error by the watchdog and stopped'
where id='7db3d841-252c-4572-95ec-bc110727df8d';

-- 2. Retire the other long-dead jobs so nothing can pick them up again.
update validation_jobs set status='cancelled',
  error_message='Abandoned since April; retired so the watchdog cannot revive it'
where status in ('pending','processing') and created_at < now() - interval '7 days';

-- 3. The actual fix: the watchdog only ever considers recent jobs. A job that
--    has sat untouched for a day is abandoned, not stalled, and reviving it
--    burns MailTester credits on a list nobody is waiting for.
create or replace function public.pipeline_watchdog() returns void
language plpgsql security definer as $$
declare
  j record; fn text; done int; key text; url text;
begin
  select decrypted_secret into key from vault.decrypted_secrets where name='service_role_key';
  select decrypted_secret into url from vault.decrypted_secrets where name='project_url';
  if key is null or url is null then return; end if;

  for j in
    select id from validation_jobs
    where status in ('pending','processing')
      and created_at > now() - interval '24 hours'   -- <— the missing guard
  loop
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
      continue;
    end if;

    if exists (select 1 from pipeline_watchdog_state s
               where s.job_id=j.id and s.last_done=done) then
      perform net.http_post(
        url := url || '/functions/v1/' || fn,
        headers := jsonb_build_object('Content-Type','application/json',
                                      'Authorization','Bearer '||key,'apikey',key),
        body := jsonb_build_object('job_id', j.id)
      );
      update pipeline_watchdog_state set checked_at=now(), revives=revives+1 where job_id=j.id;
    else
      insert into pipeline_watchdog_state(job_id,last_done) values (j.id,done)
      on conflict (job_id) do update set last_done=excluded.last_done, checked_at=now();
    end if;
  end loop;
end $$;

select id, filename, status from validation_jobs where status in ('pending','processing');
