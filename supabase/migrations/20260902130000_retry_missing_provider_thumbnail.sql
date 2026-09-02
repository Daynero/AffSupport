-- Drive makes a thumbnail when it feels like it; we asked once and gave up.
--
-- The warm pass claims `pending` rows only, so the first look after an upload —
-- which is often seconds later, before Google has processed the file — records
-- `unavailable / provider_missing` and nothing ever asks again. The tile then
-- says "no thumbnail" for a file that had one minutes afterwards (owner,
-- 2026-09-02).
--
-- A file that recently changed is retried, at most once an hour. The window
-- bounds the work by itself: Drive produces a thumbnail within minutes of an
-- upload or never, so after a day there is nothing to wait for and the row is
-- left alone.

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
    where material.lifecycle = 'active'
      and connection.state = 'connected'
      and (
        material.provider_thumbnail_state = 'pending'
        -- Asked too early. Worth one more look while the file is still new;
        -- after that Drive was never going to make one.
        or (
          material.provider_thumbnail_state = 'unavailable'
          and material.provider_thumbnail_reason = 'provider_missing'
          and material.modified_at > clock_timestamp() - interval '24 hours'
          and material.provider_thumbnail_claimed_at < clock_timestamp() - interval '1 hour'
        )
      )
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
