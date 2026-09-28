-- The long video step reports the local agent's measured progress to the catalog row.
-- The sheet worker's existing five stages begin after that copy is ready.

alter table private.catalog_restitch_jobs
  add column progress smallint not null default 0
    check (progress between 0 and 100),
  add column progress_stage text
    check (progress_stage in ('downloading', 'processing', 'uploading', 'finalizing'));

create function private.reset_catalog_restitch_job_progress()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'queued'
     or new.lease_token_hash is distinct from old.lease_token_hash then
    new.progress := 0;
    new.progress_stage := null;
  end if;
  return new;
end;
$$;

create trigger catalog_restitch_job_progress_reset
before update on private.catalog_restitch_jobs
for each row execute function private.reset_catalog_restitch_job_progress();

create function public.service_report_restitch_job_progress(
  p_actor uuid,
  p_job uuid,
  p_lease_token_hash bytea,
  p_progress integer,
  p_stage text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  renewed uuid;
begin
  if p_progress is null or p_progress not between 0 and 100
     or p_stage not in ('downloading', 'processing', 'uploading', 'finalizing') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update private.catalog_restitch_jobs as job
     set lease_expires_at = clock_timestamp() + interval '120 seconds',
         progress = greatest(job.progress, p_progress)::smallint,
         progress_stage = case when p_progress >= job.progress then p_stage
                               else job.progress_stage end
    from public.team_catalog_updaters as updater
   where job.catalog_material_id = p_job
     and job.lease_owner = p_actor
     and job.state = 'leased'
     and job.lease_token_hash = p_lease_token_hash
     and updater.team_id = job.team_id
     and updater.state = 'running'
     and updater.restitch
     and private.can(job.team_id, 'process', p_actor)
  returning job.catalog_material_id into renewed;
  return renewed is null;
end;
$$;

revoke all on function public.service_report_restitch_job_progress(
  uuid, uuid, bytea, integer, text
) from public, anon, authenticated;
grant execute on function public.service_report_restitch_job_progress(
  uuid, uuid, bytea, integer, text
) to service_role;

drop function public.list_team_product_catalogs(uuid);
create function public.list_team_product_catalogs(p_team uuid)
returns table (
  catalog_id uuid,
  name text,
  sheet_url text,
  video_id uuid,
  video_name text,
  folder_name text,
  product_count smallint,
  created_at timestamptz,
  last_updated_at timestamptz,
  update_count integer,
  in_updater boolean,
  last_update_error text,
  update_interval text,
  next_run_at timestamptz,
  update_pending boolean,
  folder_drive_id text,
  update_stage text,
  restitch_progress smallint,
  restitch_stage text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
    select sheet.id,
           sheet.name,
           record.sheet_url,
           video.id,
           video.name,
           folder.name,
           record.product_count,
           record.created_at,
           record.last_updated_at,
           record.update_count,
           coalesce(item.update_interval is not null, false),
           record.last_update_error,
           item.update_interval,
           item.next_run_at,
           coalesce(item.round_due_at is not null, false),
           sheet.parent_folder_id,
           case when item.round_due_at is not null then
             coalesce(progress.stage,
               case when restitch.catalog_material_id is not null then
                 case when restitch.state = 'leased' then 'restitching'
                      else 'waiting_video' end
               end,
               'preparing')
           end,
           case when item.round_due_at is not null and progress.stage is null
                     then restitch.progress end,
           case when item.round_due_at is not null and progress.stage is null
                     then restitch.progress_stage end
    from private.live_product_catalogs(p_team) as live
    join public.team_product_catalogs as record on record.material_id = live.catalog_material_id
    join public.team_materials as sheet on sheet.id = live.catalog_material_id
    join public.team_materials as video on video.id = live.video_material_id
    left join public.team_materials as folder
      on folder.team_id = p_team
     and folder.drive_file_id = video.parent_folder_id
     and folder.kind = 'folder'
     and folder.lifecycle = 'active'
    left join public.team_catalog_updater_items as item
      on item.catalog_material_id = live.catalog_material_id
    left join private.catalog_update_progress as progress
      on progress.catalog_material_id = live.catalog_material_id
     and progress.worker = item.lease_owner
    left join private.catalog_restitch_jobs as restitch
      on restitch.catalog_material_id = live.catalog_material_id
    order by record.created_at desc;
end;
$$;

revoke all on function public.list_team_product_catalogs(uuid) from public, anon, authenticated;
grant execute on function public.list_team_product_catalogs(uuid) to authenticated;
