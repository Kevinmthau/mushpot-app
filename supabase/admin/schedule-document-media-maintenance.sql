-- Run this only after the Edge Function is deployed and all three Vault
-- secrets listed below have been created. The block intentionally fails
-- instead of creating a broken cron job when configuration is incomplete.
--
-- Required Vault secret names:
--   mushpot_project_url
--   mushpot_publishable_key
--   mushpot_maintenance_secret

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
declare
  missing_secret text;
begin
  select required.name
  into missing_secret
  from (
    values
      ('mushpot_project_url'),
      ('mushpot_publishable_key'),
      ('mushpot_maintenance_secret')
  ) as required(name)
  where not exists (
    select 1
    from vault.decrypted_secrets as secrets
    where secrets.name = required.name
      and secrets.decrypted_secret <> ''
  )
  limit 1;

  if missing_secret is not null then
    raise exception 'Missing Vault secret: %', missing_secret;
  end if;
end;
$$;

do $$
declare
  existing_job bigint;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'mushpot-document-media-maintenance'
  loop
    perform cron.unschedule(existing_job);
  end loop;
end;
$$;

select cron.schedule(
  'mushpot-document-media-maintenance',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'mushpot_project_url'
      ) || '/functions/v1/document-media-maintenance',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'mushpot_publishable_key'
        ),
        'x-mushpot-maintenance-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'mushpot_maintenance_secret'
        )
      ),
      body := jsonb_build_object('source', 'pg_cron'),
      timeout_milliseconds := 30000
    ) as request_id;
  $cron$
);
