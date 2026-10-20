-- All consumers agree whether a prepared replacement can actually be delivered.
begin;
create function private.catalog_has_usable_spare(p_catalog uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_catalog_restitch_copies as copy
    join public.team_materials as material on material.id = copy.material_id
    where copy.catalog_material_id = p_catalog and copy.role = 'spare'
      and material.lifecycle = 'active' and nullif(copy.shared_link, '') is not null
  );
$$;
revoke all on function private.catalog_has_usable_spare(uuid) from public, anon, authenticated;
create or replace function private.queue_restitch_jobs(p_team uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.team_catalog_restitch_copies as copy
     set role = 'retired', retired_at = clock_timestamp(), next_delete_at = clock_timestamp()
   where copy.team_id = p_team and copy.role = 'spare'
     and not private.catalog_has_usable_spare(copy.catalog_material_id);
  insert into private.catalog_restitch_jobs (catalog_material_id, team_id)
  select item.catalog_material_id, p_team
  from public.team_catalog_updater_items as item
  join public.team_catalog_update_profiles as profile
    on profile.catalog_material_id = item.catalog_material_id
  where item.team_id = p_team and private.catalog_wants_restitch(item.catalog_material_id, true)
    and (item.update_interval is not null or item.round_due_at is not null)
    and not private.catalog_has_usable_spare(item.catalog_material_id)
  on conflict (catalog_material_id) do nothing;
end;
$$;

create or replace function private.claim_catalog_updater_items(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns setof public.team_catalog_updater_items
language plpgsql security definer set search_path = '' as $$
declare slots integer; gone record;
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

  -- A prepared file may be removed between preparation and the next worker tick.
  for gone in
    select distinct copy.team_id from public.team_catalog_restitch_copies as copy
    where copy.role = 'spare' and not private.catalog_has_usable_spare(copy.catalog_material_id)
  loop
    perform private.queue_restitch_jobs(gone.team_id);
  end loop;

  select greatest(0, 12 - count(*)::integer) into slots
  from public.team_catalog_updater_items where lease_expires_at > clock_timestamp();
  if slots = 0 then return; end if;

  return query
  with candidates as (
    select item.catalog_material_id
    from public.team_catalog_updater_items as item
    join public.team_catalog_update_profiles as profile
      on profile.catalog_material_id = item.catalog_material_id
    left join public.team_catalog_update_attempts as attempt
      on attempt.catalog_material_id = item.catalog_material_id
     and attempt.round_due_at = item.round_due_at
    left join private.catalog_restitch_jobs as job
      on job.catalog_material_id = item.catalog_material_id
    where item.round_due_at is not null
      and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
      and private.team_workspace_allowed(item.team_id)
      and (
        (item.update_interval is not null and coalesce(attempt.trigger_kind, 'unknown') not in ('manual', 'retry'))
        or not coalesce((attempt.profile_snapshot ->> 'restitch')::boolean, profile.restitch)
        or private.catalog_has_usable_spare(item.catalog_material_id)
        or (coalesce(attempt.trigger_kind, 'unknown') not in ('manual', 'retry')
            and item.round_due_at <= clock_timestamp() - interval '30 minutes'
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

create or replace function public.list_team_catalog_update_profiles(p_team uuid)
returns table (
  catalog_material_id uuid, refresh_images boolean, refresh_texts boolean,
  grow_products boolean, random_link_variation boolean, restitch boolean,
  version bigint, updated_at timestamptz, last_error_at timestamptz,
  restitch_status text, restitch_blocked_code text,
  reconciliation_required boolean,
  last_result text, latest_attempt_at timestamptz, last_successful_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
    select profile.catalog_material_id, profile.refresh_images, profile.refresh_texts,
           profile.grow_products, profile.random_link_variation, profile.restitch,
           profile.version, profile.updated_at, catalog.last_update_error_at,
           case when private.catalog_has_usable_spare(profile.catalog_material_id) then 'ready'
           when exists (
             select 1 from private.catalog_restitch_jobs as job
             where job.catalog_material_id = profile.catalog_material_id and job.state = 'leased'
           ) then 'preparing'
           when exists (
             select 1 from private.catalog_restitch_jobs as job
             where job.catalog_material_id = profile.catalog_material_id
               and job.last_error_code is not null
           ) then 'blocked'
           else 'waiting' end,
           (select job.last_error_code from private.catalog_restitch_jobs as job
            where job.catalog_material_id = profile.catalog_material_id
            limit 1), coalesce(item.reconciliation_required, false),
           latest.result, latest.started_at,
           (select max(attempt.delivery_verified_at)
              from public.team_catalog_update_attempts as attempt
             where attempt.catalog_material_id = profile.catalog_material_id
               and attempt.team_id = p_team
               and attempt.result = 'success'
               and attempt.delivery_verified_at is not null)
    from public.team_catalog_update_profiles as profile
    join public.team_product_catalogs as catalog
      on catalog.material_id = profile.catalog_material_id
    join private.live_product_catalogs(p_team) as live
      on live.catalog_material_id = profile.catalog_material_id
    left join public.team_catalog_updater_items as item
      on item.catalog_material_id = profile.catalog_material_id
    left join lateral (
      select attempt.result, attempt.started_at
        from public.team_catalog_update_attempts as attempt
       where attempt.catalog_material_id = profile.catalog_material_id
         and attempt.team_id = p_team
       order by attempt.started_at desc, attempt.attempt_id desc
       limit 1
    ) as latest on true
    where profile.team_id = p_team;
end;
$$;
commit;
