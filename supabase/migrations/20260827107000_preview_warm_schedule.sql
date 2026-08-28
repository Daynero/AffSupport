-- 011 (T046): the preview warm worker tick.
--
-- Same shape as the catalog sync tick: the endpoint and the worker secret are
-- Vault secrets named `wishly_preview_warm_url` and `wishly_preview_warm_secret`
-- (set them with the same procedure as `wishly_catalog_sync_*`, see
-- docs/TEAM_WORKSPACE_OPERATIONS.md); a missing secret makes the tick a no-op
-- rather than a failing job. Every five minutes — the reconciliation interval.
-- Forward-only. Reverse steps are in ROLLBACK.md.

create or replace function private.invoke_preview_warm_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  worker_secret text;
  request_id bigint;
begin
  select secret.decrypted_secret into endpoint
  from vault.decrypted_secrets as secret
  where secret.name = 'wishly_preview_warm_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret
  where secret.name = 'wishly_preview_warm_secret'
  order by secret.created_at desc limit 1;
  if endpoint is null or endpoint !~ '^https?://' or worker_secret is null
     or char_length(worker_secret) < 32 then
    return null;
  end if;
  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object(
      'content-type', 'application/json',
      'x-preview-warm-secret', worker_secret
    ),
    body := '{"scheduled":true}'::jsonb,
    timeout_milliseconds := 5000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function private.invoke_preview_warm_worker()
from public, anon, authenticated, service_role;

select cron.unschedule(job.jobid)
from cron.job as job
where job.jobname = 'wishly-preview-warm';

select cron.schedule(
  'wishly-preview-warm',
  '*/5 * * * *',
  $cron$select private.invoke_preview_warm_worker()$cron$
);
