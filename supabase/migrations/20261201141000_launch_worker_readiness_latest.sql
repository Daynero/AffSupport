-- Match dispatcher selection when a worker secret or endpoint has been rotated.
create or replace function public.service_launch_worker_ready() returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select private.catalog_updater_endpoint(s.decrypted_secret) is not null
   from vault.decrypted_secrets s where s.name='wishly_catalog_sync_url' order by s.created_at desc limit 1),false)
 and coalesce((select char_length(s.decrypted_secret)>=32 from vault.decrypted_secrets s
   where s.name='wishly_catalog_sync_secret' order by s.created_at desc limit 1),false)
 and exists(select 1 from cron.job j where j.jobname='wishly-catalog-updater' and j.active)
$$;
