-- 011 (T016): the worker-side markers and the preview-warm claim/commit pair.
--
--   service_mark_folder_indexed   a folder is openable the moment its last page lands
--   service_claim_preview_warm    up to N pending thumbnails in indexed folders, leased
--   service_commit_thumbnail      the outcome, bound to the version it was fetched for
--
-- The existing catalog page upsert is untouched: thumbnail state and selection
-- are trigger-maintained (20260827103000). Forward-only; see ROLLBACK.md.

create or replace function public.service_mark_folder_indexed(
  p_connection uuid,
  p_drive_folder_id text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
  folder_id uuid;
begin
  update public.team_materials as material
  set folder_indexed_at = clock_timestamp()
  where material.connection_id = p_connection
    and material.drive_file_id = p_drive_folder_id
    and material.kind = 'folder'
  returning material.team_id, material.id into resolved_team, folder_id;
  if folder_id is null then
    -- The root has no row of its own; nothing to stamp, nothing to announce.
    return 0;
  end if;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (resolved_team, folder_id, 'folder_indexed');
  return 1;
end;
$$;

revoke all on function public.service_mark_folder_indexed(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_mark_folder_indexed(uuid, text) to service_role;

-- Oldest indexed folder first, so a space fills in from the top. Rows whose
-- lease lapsed (a worker that died mid-fetch) come back after ten minutes.
create or replace function public.service_claim_preview_warm(p_limit integer default 50)
returns table (
  material_id uuid,
  team_id uuid,
  connection_id uuid,
  credential_id uuid,
  drive_file_id text,
  resource_key text,
  drive_version text,
  mime_type text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  with candidate as (
    select material.id
    from public.team_materials as material
    join public.team_drive_connections as connection on connection.id = material.connection_id
    left join public.team_materials as parent
      on parent.team_id = material.team_id
     and parent.connection_id = material.connection_id
     and parent.drive_file_id = material.parent_folder_id
     and parent.kind = 'folder'
    where material.provider_thumbnail_state = 'pending'
      and material.lifecycle = 'active'
      and connection.state = 'connected'
      and (
        material.provider_thumbnail_claimed_at is null
        or material.provider_thumbnail_claimed_at < clock_timestamp() - interval '10 minutes'
      )
      and (
        parent.folder_indexed_at is not null
        or material.parent_folder_id = connection.root_folder_id
      )
    order by coalesce(parent.folder_indexed_at, connection.connected_at), material.id
    for update of material skip locked
    limit p_limit
  )
  update public.team_materials as material
  set provider_thumbnail_claimed_at = clock_timestamp()
  from candidate, public.team_drive_connections as connection
  where material.id = candidate.id
    and connection.id = material.connection_id
  returning material.id, material.team_id, material.connection_id, connection.credential_id,
            material.drive_file_id, material.resource_key, material.drive_version, material.mime_type;
end;
$$;

revoke all on function public.service_claim_preview_warm(integer)
from public, anon, authenticated, service_role;
grant execute on function public.service_claim_preview_warm(integer) to service_role;

-- A result for a version the catalog no longer holds is not "ready": it goes
-- back to pending and the next pass fetches the current file (FR-019).
create or replace function public.service_commit_thumbnail(
  p_material uuid,
  p_state text,
  p_reason text default null,
  p_version text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.team_materials%rowtype;
  committed text;
begin
  if p_state not in ('ready', 'unavailable', 'pending')
     or (p_state = 'ready' and p_version is null)
     or (p_reason is not null and p_reason not in (
       'unsupported', 'corrupt', 'protected', 'too_large', 'provider_missing'
     )) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into target from public.team_materials as material where material.id = p_material for update;
  if target.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if target.provider_thumbnail_state = 'not_applicable' then
    return 'not_applicable';
  end if;
  committed := case
    when p_state = 'ready' and target.drive_version is distinct from p_version then 'pending'
    else p_state
  end;
  update public.team_materials
  set provider_thumbnail_state = committed,
      provider_thumbnail_reason = case when committed = 'unavailable' then p_reason else null end,
      provider_thumbnail_version = case when committed = 'ready' then p_version else null end,
      provider_thumbnail_claimed_at = null
  where id = p_material;
  if committed = 'ready' then
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (target.team_id, target.id, 'thumbnail_ready');
  end if;
  return committed;
end;
$$;

revoke all on function public.service_commit_thumbnail(uuid, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_commit_thumbnail(uuid, text, text, text) to service_role;

-- Reconciliation walks every picked folder, not only the root (T018).
create or replace function public.service_enqueue_catalog_reconciliation(p_connection uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_job uuid;
  token text;
  root text;
  queue jsonb;
begin
  select connection.change_page_token, connection.root_folder_id into token, root
  from public.team_drive_connections as connection
  where connection.id = p_connection and connection.state <> 'detached';
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  -- The root walks first, then every other picked folder.
  select jsonb_build_array(root)
         || coalesce(jsonb_agg(selection.drive_folder_id order by selection.selected_at), '[]'::jsonb)
    into queue
  from public.team_drive_selections as selection
  where selection.connection_id = p_connection
    and selection.state = 'active'
    and not selection.is_root;
  insert into private.catalog_sync_jobs (connection_id, phase, cursor, folder_queue)
  values (
    p_connection, 'initial_scan',
    pg_catalog.jsonb_build_object('pageToken', null, 'changePageToken', token, 'discoveredFolders', '[]'::jsonb),
    queue
  ) returning id into created_job;
  return created_job;
end;
$$;
