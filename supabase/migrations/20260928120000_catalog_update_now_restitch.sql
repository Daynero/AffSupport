-- A one-off catalog update needs the same prepared video as a scheduled round.
-- Keep its updater active while the round waits for that copy, then return to stopped.

alter table public.team_catalog_updaters
  drop constraint team_catalog_updaters_due_check;
alter table public.team_catalog_updaters
  add constraint team_catalog_updaters_due_check
  check (state = 'running' or next_run_at is null);

create or replace function private.sync_catalog_updater(p_team uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  earliest timestamptz;
  preparing_one_off boolean;
begin
  delete from public.team_catalog_updater_items as item
  where item.team_id = p_team and item.update_interval is null and item.round_due_at is null;

  select min(item.next_run_at) into earliest
  from public.team_catalog_updater_items as item
  where item.team_id = p_team and item.update_interval is not null;

  select exists (
    select 1
    from public.team_catalog_updaters as updater
    join public.team_catalog_updater_items as item on item.team_id = updater.team_id
    where updater.team_id = p_team and updater.restitch
      and item.round_due_at is not null
  ) into preparing_one_off;

  update public.team_catalog_updaters as updater
     set state = case when earliest is null and not preparing_one_off then 'stopped' else 'running' end,
         next_run_at = earliest,
         started_at = case
           when earliest is null and not preparing_one_off then updater.started_at
           when updater.state <> 'running' then clock_timestamp()
           else updater.started_at
         end,
         started_by = case
           when (earliest is not null or preparing_one_off) and updater.state <> 'running'
             then auth.uid()
           else updater.started_by
         end,
         updated_by = coalesce(auth.uid(), updater.updated_by),
         updated_at = clock_timestamp()
   where updater.team_id = p_team;

  if exists (
    select 1 from public.team_catalog_updaters as updater
    where updater.team_id = p_team and updater.restitch and updater.state = 'running'
  ) then
    perform private.retire_restitch_spares(p_team, array(
      select item.catalog_material_id from public.team_catalog_updater_items as item
      where item.team_id = p_team
        and (item.update_interval is not null or item.round_due_at is not null)
    ));
    perform private.queue_restitch_jobs(p_team);
  else
    perform private.retire_restitch_spares(p_team, null);
  end if;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
end;
$$;

create or replace function private.queue_restitch_jobs(p_team uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.team_catalog_updaters as updater
    where updater.team_id = p_team and updater.state = 'running' and updater.restitch
  ) then return; end if;
  insert into private.catalog_restitch_jobs (catalog_material_id, team_id)
  select item.catalog_material_id, p_team
  from public.team_catalog_updater_items as item
  where item.team_id = p_team
    and (item.update_interval is not null or item.round_due_at is not null)
    and not exists (
      select 1 from public.team_catalog_restitch_copies as copy
      where copy.catalog_material_id = item.catalog_material_id and copy.role = 'spare'
    )
  on conflict (catalog_material_id) do nothing;
end;
$$;

-- Let an update-now round wait for its video while an app is preparing it. If nobody is
-- available, it may use the old video after thirty minutes. A live lease continues to wait.
create or replace function private.claim_catalog_updater_items(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns setof public.team_catalog_updater_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  slots integer;
  gone record;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(72301500) then return; end if;

  for gone in
    delete from public.team_catalog_updater_items as item
    where item.round_due_at is not null
      and not exists (
        select 1 from private.live_product_catalogs(item.team_id) as live
        where live.catalog_material_id = item.catalog_material_id
      )
    returning item.team_id, item.catalog_material_id
  loop
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (gone.team_id, gone.catalog_material_id, 'upserted');
    perform private.sync_catalog_updater(gone.team_id);
  end loop;

  select greatest(0, 12 - count(*)::integer) into slots
  from public.team_catalog_updater_items
  where lease_expires_at > clock_timestamp();
  if slots = 0 then return; end if;

  return query
  with candidates as (
    select item.catalog_material_id
    from public.team_catalog_updater_items as item
    left join public.team_catalog_updaters as updater on updater.team_id = item.team_id
    left join private.catalog_restitch_jobs as job
      on job.catalog_material_id = item.catalog_material_id
    where item.round_due_at is not null
      and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
      and (
        item.update_interval is not null
        or
        not coalesce(updater.restitch, false)
        or exists (
          select 1 from public.team_catalog_restitch_copies as copy
          where copy.catalog_material_id = item.catalog_material_id and copy.role = 'spare'
        )
        or (item.round_due_at <= clock_timestamp() - interval '30 minutes'
            and (job.catalog_material_id is null or job.state <> 'leased'
                 or job.lease_expires_at <= clock_timestamp()))
      )
    order by item.next_attempt_at, item.round_due_at
    for update of item skip locked
    limit least(greatest(p_limit, 1), slots)
  )
  update public.team_catalog_updater_items as item
     set lease_owner = p_worker,
         lease_expires_at = clock_timestamp()
           + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
         next_attempt_at = clock_timestamp()
           + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
         attempts = item.attempts + 1
    from candidates
   where item.catalog_material_id = candidates.catalog_material_id
  returning item.*;
end;
$$;

create or replace function private.forget_unscheduled_catalog_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.round_due_at is null and new.update_interval is null then
    delete from public.team_catalog_updater_items
    where catalog_material_id = new.catalog_material_id;
    perform private.sync_catalog_updater(new.team_id);
  end if;
  return null;
end;
$$;
