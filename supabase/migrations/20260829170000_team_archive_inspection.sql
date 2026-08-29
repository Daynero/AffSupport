-- 011 (findings J2): a landing package the owner put into Drive stayed an
-- "archive" until somebody opened it on a computer with the agent — the only
-- code that ever looked inside. The preview-warm pass now reads each new
-- archive's central directory from Drive (a range request, no download) and
-- promotes the ones that hold an index.html, with the same fingerprint the
-- agent would compute.

alter table public.team_materials
  add column if not exists landing_inspection_claimed_at timestamptz;

create or replace function public.service_claim_archive_inspections(p_limit integer default 20)
returns table (
  material_id uuid,
  team_id uuid,
  credential_id uuid,
  drive_file_id text,
  resource_key text,
  drive_version text,
  checksum text,
  size_bytes bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  with candidate as (
    select material.id
    from public.team_materials as material
    join public.team_drive_connections as connection on connection.id = material.connection_id
    where material.kind = 'file'
      and material.category = 'archive'
      and material.landing_validation_state is null
      and material.lifecycle = 'active'
      and material.size_bytes is not null
      and material.size_bytes between 22 and 2147483647
      and connection.state = 'connected'
      and (
        material.landing_inspection_claimed_at is null
        or material.landing_inspection_claimed_at < clock_timestamp() - interval '10 minutes'
      )
    order by material.created_at, material.id
    for update of material skip locked
    limit p_limit
  )
  update public.team_materials as material
  set landing_inspection_claimed_at = clock_timestamp()
  from candidate, public.team_drive_connections as connection
  where material.id = candidate.id
    and connection.id = material.connection_id
  returning material.id, material.team_id, connection.credential_id, material.drive_file_id,
            material.resource_key, material.drive_version, material.checksum, material.size_bytes;
end;
$$;

revoke all on function public.service_claim_archive_inspections(integer)
from public, anon, authenticated;
grant execute on function public.service_claim_archive_inspections(integer) to service_role;

-- p_outcome: 'landing' (validated, becomes a landing), 'archive' (looked, no
-- page inside — stays an archive and is not asked again), 'unavailable' (the
-- bytes could not be read as a ZIP; also final). The version guard keeps a
-- decision from landing on a file that changed while it was being read.
create or replace function public.service_commit_archive_inspection(
  p_material uuid,
  p_outcome text,
  p_version text,
  p_fingerprint text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  material_row public.team_materials%rowtype;
begin
  if p_outcome not in ('landing', 'archive', 'unavailable') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_outcome = 'landing' and (p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into material_row from public.team_materials as material
  where material.id = p_material for update;
  if material_row.id is null
     or material_row.kind <> 'file'
     or material_row.lifecycle <> 'active'
     or material_row.category <> 'archive'
     or material_row.landing_validation_state is not null
     or material_row.drive_version is distinct from p_version then
    return false;
  end if;
  if p_outcome = 'landing' then
    update public.team_materials as material
    set category = 'landing',
        classification_source = 'inspected_landing',
        landing_validation_state = 'validated',
        landing_validation_version = p_version,
        landing_validation_fingerprint = p_fingerprint,
        preview_state = 'pending',
        preview_error_code = null,
        landing_inspection_claimed_at = null,
        updated_at = clock_timestamp()
    where material.id = p_material;
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (material_row.team_id, p_material, 'upserted');
  else
    update public.team_materials as material
    set landing_validation_state = case when p_outcome = 'archive' then 'invalid' else 'unavailable' end,
        landing_inspection_claimed_at = null,
        updated_at = clock_timestamp()
    where material.id = p_material;
  end if;
  return true;
end;
$$;

revoke all on function public.service_commit_archive_inspection(uuid, text, text, text)
from public, anon, authenticated;
grant execute on function public.service_commit_archive_inspection(uuid, text, text, text)
to service_role;
