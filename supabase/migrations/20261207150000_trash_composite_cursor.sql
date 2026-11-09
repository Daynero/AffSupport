-- A timestamp alone skips a tied batch. Preserve the legacy RPC for old clients.
create or replace function public.list_team_trashed_materials_v2(
  p_team uuid, p_limit int default 50, p_before timestamptz default null,
  p_before_id uuid default null
)
returns table (id uuid, name text, kind text, trashed_at timestamptz, parent_path_hint text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if (p_before is null) <> (p_before_id is null)
     or (p_before is not null and not pg_catalog.isfinite(p_before)) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  select material.id, material.name, material.kind, material.trashed_at, parent.name
  from public.team_materials as material
  left join public.team_materials as parent
    on parent.team_id = material.team_id
   and parent.drive_file_id = material.parent_folder_id
   and parent.kind = 'folder'
  where material.team_id = p_team and material.lifecycle = 'trashed'
    and material.trashed_at is not null and material.folder_trash_root is null
    and (p_before is null or (material.trashed_at, material.id) < (p_before, p_before_id))
  order by material.trashed_at desc, material.id desc
  limit p_limit;
end;
$$;

revoke all on function public.list_team_trashed_materials_v2(uuid, int, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_team_trashed_materials_v2(uuid, int, timestamptz, uuid)
  to authenticated;
