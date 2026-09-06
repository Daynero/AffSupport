-- The last place the batch still asked "is this in the Creative Library?"
--
-- `scan_library_requirements` and `claim_library_job` were taught that a
-- catalog file with no `library_stage` is ordinary library material. This one
-- was not, so the loop claimed a job and then could not say what it was about:
-- every claim came straight back as NOT_FOUND, and a batch over two chosen
-- videos reported "failed: 2" a second after it started.

create or replace function public.get_library_processing_context(
  p_team uuid,
  p_source uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload jsonb;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'sourceMaterialId', source.id,
    'sourceName', source.name,
    'category', source.category,
    'destinationFolderId', folder.id
  ) into payload
  from public.team_materials as source
  join public.team_materials as folder
    on folder.team_id = source.team_id
   and folder.connection_id = source.connection_id
   and folder.drive_file_id = source.parent_folder_id
   and folder.kind = 'folder' and folder.lifecycle = 'active'
  where source.id = p_source and source.team_id = p_team
    and source.lifecycle = 'active'
    and coalesce(source.library_stage, 'library') = 'library';
  if payload is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return payload;
end;
$$;

-- The rows that failed for this reason are work that was never attempted; a
-- fresh scan should offer them again rather than leave them sitting as errors.
-- Only where the source is still there: a row whose material was deleted failed
-- for a reason this migration does not fix, and reviving it would put a job in
-- the queue that can never run.
update public.team_library_requirements as requirement
   set state = 'pending', last_error_code = null
 where requirement.state = 'failed'
   and requirement.last_error_code = 'NOT_FOUND'
   and exists (
     select 1 from public.team_materials as material
     where material.id = requirement.source_material_id
       and material.team_id = requirement.team_id
       and material.lifecycle = 'active'
   );
