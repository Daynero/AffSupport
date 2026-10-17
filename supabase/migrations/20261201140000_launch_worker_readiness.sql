-- Return capability only, never worker URLs or secrets, before accepting hosted work.
create function public.service_launch_worker_ready() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from vault.decrypted_secrets s where s.name='wishly_catalog_sync_url'
   and private.catalog_updater_endpoint(s.decrypted_secret) is not null)
 and exists(select 1 from vault.decrypted_secrets s where s.name='wishly_catalog_sync_secret' and char_length(s.decrypted_secret)>=32)
 and exists(select 1 from cron.job j where j.jobname='wishly-catalog-updater' and j.active)
$$;
revoke all on function public.service_launch_worker_ready() from public,anon,authenticated;
grant execute on function public.service_launch_worker_ready() to service_role;
