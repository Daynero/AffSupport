-- 057 T110/T111: a public copy of a catalog video in an R2 space counts against the space's own
-- ledger (FR-045, FR-047, FR-050), not against the legacy catalog-video copy quota.
--
-- A catalog's video in an R2 space is always its public R2 copy (050, catalog_video_r2_copies:
-- one copy per video version, however many catalogs use it). Until now that copy was planned
-- against private.catalog_video_r2_config.team_quota_bytes (5 GB per space) and never reached the
-- space's ledger: an R2 space had two limits, and its scale did not show the copies. In an R2
-- space now:
--
-- * planning checks the space's free bytes (capacity − used − reserved) instead of the legacy
--   quota and is refused STORAGE_QUOTA_EXCEEDED before any row; the planned copy reserves its
--   bytes (space_storage_reservations, purpose `catalog_video`, keyed by the copy id);
-- * a copy that becomes ready settles the reservation and counts once under `catalogs`
--   (`space_counted`); retiring and back changes nothing; failed or deleted (state or row) gives
--   the bytes back — the ledger only ever decreases here, never recreates a row for a space that
--   is being removed (as catalog_feed_released).
--
-- A Drive space is held to the legacy quota exactly as before: the guarded line of
-- service_catalog_video_r2_resolve keeps its old condition for it, and the ledger trigger leaves
-- its copies alone.

alter table public.space_storage_reservations drop constraint space_storage_reservations_purpose_check;
alter table public.space_storage_reservations add constraint space_storage_reservations_purpose_check
  check (purpose = any (array['upload', 'process_output', 'catalog_generation', 'catalog_video']));

alter table private.catalog_video_r2_copies add column space_counted boolean not null default false;

-- 1. Planning ------------------------------------------------------------------------------------

create function private.space_free_bytes(p_team uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select greatest(0, private.space_capacity_bytes(p_team) - private.space_used_bytes(p_team)
    - private.space_reserved_bytes(p_team));
$$;
revoke all on function private.space_free_bytes(uuid) from public, anon, authenticated;

do $patch$
declare d text;
begin
  select pg_get_functiondef('public.service_catalog_video_r2_resolve(uuid,uuid,text,bigint,text,text,uuid,uuid,boolean)'::regprocedure) into d;
  if strpos(d, 'space_storage_copy_ledger') = 0 then
    if strpos(d, $find$  when private.catalog_video_r2_team_used_bytes(pref.team_id)+p_size_bytes>cfg.team_quota_bytes then 'VIDEO_R2_QUOTA_EXCEEDED'$find$) = 0 then
      raise exception 'CATALOG_COPY_LEDGER_PATCH_MISSING';
    end if;
    d := replace(d, $find$  when private.catalog_video_r2_team_used_bytes(pref.team_id)+p_size_bytes>cfg.team_quota_bytes then 'VIDEO_R2_QUOTA_EXCEEDED'$find$,
      $replace$  -- space_storage_copy_ledger (057 T111): an R2 space's one limit is its own ledger.
  when private.space_is_r2(pref.team_id) and p_size_bytes>private.space_free_bytes(pref.team_id) then 'STORAGE_QUOTA_EXCEEDED'
  when not private.space_is_r2(pref.team_id) and private.catalog_video_r2_team_used_bytes(pref.team_id)+p_size_bytes>cfg.team_quota_bytes then 'VIDEO_R2_QUOTA_EXCEEDED'$replace$);
    execute d;
  end if;
end $patch$;

-- 2. The ledger follows the copy -----------------------------------------------------------------

-- Only ever lowers what is there: a space that is being removed has no row to recreate.
create function private.space_catalog_copy_uncount(p_team uuid, p_bytes bigint) returns void
language sql security definer set search_path = '' as $$
  update public.space_storage_usage set
    bytes = greatest(bytes - p_bytes, shared_bytes),
    objects = greatest(objects - 1, 0),
    revision = revision + 1
  where team_id = p_team and category = 'catalogs';
$$;
revoke all on function private.space_catalog_copy_uncount(uuid, bigint) from public, anon, authenticated;

create function private.space_catalog_copy_ledger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c private.catalog_video_r2_copies%rowtype := case when tg_op = 'DELETE' then old else new end;
begin
  if not private.space_is_r2(c.team_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.space_counted then
      perform private.space_catalog_copy_uncount(old.team_id, old.size_bytes);
    else
      update public.space_storage_reservations set state = 'released', settled_at = clock_timestamp()
       where operation_id = old.id and state in ('reserved', 'uncertain');
    end if;
    return old;
  end if;
  if new.state in ('planned', 'uploading', 'verifying') and not new.space_counted then
    -- Planned (or planned again): its bytes are reserved in the space until it is ready.
    insert into public.space_storage_reservations (team_id, operation_id, bytes, purpose, expires_at)
    values (new.team_id, new.id, new.size_bytes, 'catalog_video', clock_timestamp() + interval '7 days')
    on conflict (operation_id) do update set state = 'reserved', settled_at = null, bytes = excluded.bytes
      where public.space_storage_reservations.state = 'released';
  elsif new.state in ('ready', 'retiring') and not new.space_counted then
    update public.space_storage_reservations set state = 'committed', settled_at = clock_timestamp()
     where operation_id = new.id and state in ('reserved', 'uncertain');
    perform private.space_usage_add(new.team_id, 'catalogs', new.size_bytes, 1, 0);
    new.space_counted := true;
  elsif new.state in ('failed', 'deleted') then
    if new.space_counted then
      perform private.space_catalog_copy_uncount(new.team_id, new.size_bytes);
      new.space_counted := false;
    else
      update public.space_storage_reservations set state = 'released', settled_at = clock_timestamp()
       where operation_id = new.id and state in ('reserved', 'uncertain');
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.space_catalog_copy_ledger() from public, anon, authenticated;

create trigger space_catalog_copy_ledger_insert before insert on private.catalog_video_r2_copies
for each row execute function private.space_catalog_copy_ledger();
create trigger space_catalog_copy_ledger_update before update of state on private.catalog_video_r2_copies
for each row when (old.state is distinct from new.state) execute function private.space_catalog_copy_ledger();
create trigger space_catalog_copy_ledger_delete before delete on private.catalog_video_r2_copies
for each row execute function private.space_catalog_copy_ledger();
