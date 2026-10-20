-- 034 increment 1: restore tariff-held recurring schedules in the renewal transaction.
-- Full one-off/checkpoint/agent recovery remains tracked in 034 T033–T038 / 036.
begin;

create or replace function private.apply_tariff_pauses(p_team uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  paused integer := 0;
  closed record;
begin
  for closed in
    select distinct item.team_id
    from public.team_catalog_updater_items as item
    where (p_team is null or item.team_id = p_team)
      and (item.update_interval is not null or item.round_due_at is not null)
      and not private.team_workspace_allowed(item.team_id)
  loop
    -- Admin RPCs already own their tariff row before taking the updater lock.
    -- Take the same order in the sweep, then re-read access after waiting.
    -- A team can also have historical revoked tariffs. Do not wait while
    -- holding a different historical row: two admin transactions could own
    -- different rows before entering this helper. A later sweep retries it;
    -- the access gate already refuses all work while closed.
    begin
      perform 1 from public.space_tariffs as tariff
      where tariff.team_id = closed.team_id order by tariff.id for update nowait;
    exception when lock_not_available then
      continue;
    end;
    perform 1 from public.team_catalog_updaters as updater
    where updater.team_id = closed.team_id for update;
    if private.team_workspace_allowed(closed.team_id) then continue; end if;
    update public.team_catalog_updater_items as item
       set paused_interval = coalesce(item.update_interval, item.paused_interval),
           update_interval = null,
           next_run_at = null,
           round_due_at = null,
           attempts = 0,
           lease_owner = null,
           lease_expires_at = null,
           next_attempt_at = clock_timestamp()
     where item.team_id = closed.team_id
       and (item.update_interval is not null or item.round_due_at is not null);
    update public.team_catalog_updaters as updater
       set paused_by_tariff_at = coalesce(updater.paused_by_tariff_at, clock_timestamp())
     where updater.team_id = closed.team_id
       and exists (
         select 1 from public.team_catalog_updater_items as item
         where item.team_id = closed.team_id and item.paused_interval is not null
       );
    perform private.sync_catalog_updater(closed.team_id);
    paused := paused + 1;
  end loop;
  return paused;
end;
$$;

revoke all on function private.apply_tariff_pauses(uuid) from public, anon, authenticated;


-- Capture a natural expiry before an admin changes it back to allowed. The old
-- tariff is still visible here; do not wait for the ten-minute pause sweep.
create function private.capture_tariff_catalog_pause()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.team_id is not null and not private.team_workspace_allowed(old.team_id) then
    perform private.apply_tariff_pauses(old.team_id);
  end if;
  return new;
end;
$$;
revoke all on function private.capture_tariff_catalog_pause() from public,anon,authenticated,service_role;
create trigger space_tariff_capture_catalog_pause
  before update of ends_on,revoked_at on public.space_tariffs
  for each row execute function private.capture_tariff_catalog_pause();

-- No new work for a repeated renewal or a manual disable. In particular, do
-- not recreate deleted items or reset a round/attempt that is already running.
create function private.restore_tariff_catalog_schedules(p_team uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare restored integer;
begin
  -- Serialize against the pause sweep without locking unrelated historical
  -- revoked tariffs. Renewal already owns its tariff; compatibility callers
  -- acquire the live one first. The sweep never waits on these tariff locks.
  perform 1 from public.space_tariffs where team_id=p_team and revoked_at is null
    order by id for update;
  perform 1 from public.team_catalog_updaters where team_id=p_team for update;
  if not private.team_workspace_allowed(p_team) then return 0; end if;
  update public.team_catalog_updater_items as item
     set update_interval=item.paused_interval,
         next_run_at=clock_timestamp(),
         paused_interval=null
   where item.team_id=p_team and item.paused_interval is not null;
  get diagnostics restored = row_count;
  if restored > 0 then
    perform private.clear_tariff_pause_mark(p_team);
    -- Existing scheduler opens just one current round and advances using the
    -- unmodified profile calendar. Existing global worker slots bound work.
    perform private.sync_catalog_updater(p_team);
  end if;
  return restored;
end;
$$;
revoke all on function private.restore_tariff_catalog_schedules(uuid) from public,anon,authenticated,service_role;

create or replace function private.after_space_tariff_change(p_team uuid,p_was_allowed boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare now_allowed boolean;
begin
  if p_team is null then return; end if;
  now_allowed := private.team_workspace_allowed(p_team);
  if p_was_allowed and not now_allowed then
    perform private.apply_tariff_pauses(p_team);
  elsif not p_was_allowed and now_allowed then
    perform private.restore_tariff_catalog_schedules(p_team);
    perform private.resume_space_sync(p_team);
  end if;
end;
$$;

-- Compatibility for an older browser: same idempotent entry point. It must
-- never re-enable a manually stopped catalog or add another catch-up round.
create or replace function public.resume_team_catalog_updater(p_team uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team,'process',auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform private.restore_tariff_catalog_schedules(p_team);
  return true;
end;
$$;

-- A tariff pause is not a user's interval preference change (041).
create or replace function private.catalog_settings_observation(p_catalog uuid)
returns table(team_id uuid,creator_id uuid,profile_version bigint,state jsonb)
language sql stable security definer set search_path = '' as $$
  select profile.team_id, catalog.created_by, profile.version,
    jsonb_build_object(
      'updateInterval',coalesce(item.update_interval,item.paused_interval),'schedule',profile.schedule,
      'refreshImages',profile.refresh_images,'refreshTexts',profile.refresh_texts,
      'growProducts',profile.grow_products,'randomLinkVariation',profile.random_link_variation,
      'restitch',profile.restitch,'isDeleted',false,
      'isActive',coalesce(sheet.team_id = profile.team_id and sheet.lifecycle = 'active'
        and sheet.companion_kind = 'product_catalog' and video.lifecycle = 'active'
        and video.category = 'video',false))
  from public.team_catalog_update_profiles as profile
  join public.team_product_catalogs as catalog on catalog.material_id = profile.catalog_material_id
  left join public.team_catalog_updater_items as item on item.catalog_material_id = profile.catalog_material_id
  left join public.team_materials as sheet on sheet.id = profile.catalog_material_id
  left join public.team_materials as video on video.id = sheet.companion_of
  where profile.catalog_material_id = p_catalog;
$$;


commit;
