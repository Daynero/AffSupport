-- A single bounded catalog slice may need several Drive metadata reads.  The
-- worker leases one job per invocation, so allow that request enough time to
-- complete its checkpoint instead of cancelling it after five seconds.

create or replace function private.invoke_catalog_sync_worker()
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
  where secret.name = 'wishly_catalog_sync_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret
  where secret.name = 'wishly_catalog_sync_secret'
  order by secret.created_at desc limit 1;
  if endpoint is null or endpoint !~ '^https?://' or worker_secret is null
     or char_length(worker_secret) < 32 then
    return null;
  end if;
  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object(
      'content-type', 'application/json',
      'x-catalog-sync-secret', worker_secret
    ),
    body := '{"scheduled":true}'::jsonb,
    timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function private.invoke_catalog_sync_worker() from public, anon, authenticated;
