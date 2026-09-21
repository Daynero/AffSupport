-- Emergency production relief: background catalog work must not starve interactive workspace reads.
-- The previous ten-second schedules could keep Edge workers and Postgres writes continuously active
-- while a large Drive was undergoing its first scan.

create index if not exists team_materials_workspace_page_idx
  on public.team_materials (
    team_id,
    connection_id,
    parent_folder_id,
    (case when kind = 'folder' then '0' else '1' end),
    lower(name),
    id
  )
  where lifecycle = 'active';

select cron.unschedule(job.jobid)
from cron.job as job
where job.jobname = 'wishly-catalog-sync';

select cron.schedule(
  'wishly-catalog-sync',
  '30 seconds',
  $cron$select private.invoke_catalog_sync_worker()$cron$
);

select cron.unschedule(job.jobid)
from cron.job as job
where job.jobname = 'wishly-catalog-updater';

select cron.schedule(
  'wishly-catalog-updater',
  '* * * * *',
  $cron$select private.invoke_catalog_updater_worker()$cron$
);
