-- 011 (T012): connection state for a deleted root, the granted scope set,
-- proactive refresh bookkeeping, and the reconciliation timestamp the storage
-- chip shows. Also widens the catalog event vocabulary the explorer listens to.
-- Forward-only. Reverse steps are in ROLLBACK.md.

alter table public.team_drive_connections
  drop constraint team_drive_connections_state_check;
alter table public.team_drive_connections
  add constraint team_drive_connections_state_check check (
    state in ('pending', 'connected', 'needs_reauth', 'unavailable', 'detached', 'root_missing')
  );

alter table public.team_drive_connections
  add column scope_set text[] not null default '{}'::text[],
  add column access_expires_at timestamptz,
  add column last_reconciled_at timestamptz;

alter table public.team_catalog_events
  drop constraint team_catalog_events_kind_check;
alter table public.team_catalog_events
  add constraint team_catalog_events_kind_check check (
    event_kind in (
      'upserted', 'tombstoned', 'restored', 'sync_state',
      'folder_indexed', 'thumbnail_ready', 'storage_state'
    )
  );

-- Change replay reports what happened to the root itself: renamed or moved
-- (the space follows), or trashed/removed (the space says so and offers a way
-- back). Nothing is deleted in either case.
create or replace function public.service_mark_root_state(
  p_connection uuid,
  p_state text,
  p_root_name text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
begin
  if p_state not in ('connected', 'root_missing') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_drive_connections
  set state = p_state,
      root_folder_name = coalesce(left(nullif(btrim(p_root_name), ''), 255), root_folder_name),
      last_error_code = case when p_state = 'root_missing' then 'ROOT_MISSING' else null end
  where id = p_connection
    and state in ('connected', 'root_missing')
  returning team_id into resolved_team;
  if resolved_team is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (resolved_team, null, 'storage_state');
end;
$$;

revoke all on function public.service_mark_root_state(uuid, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_mark_root_state(uuid, text, text) to service_role;

-- The worker calls this when a change page completes; the chip shows the time.
create or replace function public.service_touch_catalog_reconciled(p_connection uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.team_drive_connections
  set last_reconciled_at = clock_timestamp()
  where id = p_connection and state <> 'detached';
$$;

revoke all on function public.service_touch_catalog_reconciled(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_touch_catalog_reconciled(uuid) to service_role;

-- Proactive refresh: the worker records when the access token it holds runs
-- out so the next caller refreshes ahead of failure rather than after it.
create or replace function public.service_record_access_expiry(
  p_credential uuid,
  p_expires_at timestamptz,
  p_scope_set text[] default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.team_drive_connections
  set access_expires_at = p_expires_at,
      scope_set = coalesce(p_scope_set, scope_set)
  where credential_id = p_credential and state <> 'detached';
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.service_record_access_expiry(uuid, timestamptz, text[])
from public, anon, authenticated, service_role;
grant execute on function public.service_record_access_expiry(uuid, timestamptz, text[])
  to service_role;
