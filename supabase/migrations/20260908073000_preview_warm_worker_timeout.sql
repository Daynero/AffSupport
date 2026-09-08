-- Preview warming can fetch and persist a bounded batch of provider thumbnails.
-- Five seconds is shorter than a healthy pass on a cold Drive connection, which
-- makes pg_net cancel it before the worker can commit any prepared previews.
-- Keep the same bounded 60-second delivery window used by catalog-sync.

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
    timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end;
$$;
