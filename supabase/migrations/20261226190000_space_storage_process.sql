-- 057 M1 (T035): tool runs in an R2 space (specs/057-r2-workspaces/contracts/storage-api.md,
-- `/process/start`, `/agent/source`, `/process/output/*`).
--
-- Additive: three new service functions and one private function body replaced. A Drive space
-- never reaches any of them — every one refuses a Drive space with STORAGE_BACKEND_MISMATCH
-- through private.require_space_actor, and the replaced category function is read only for R2
-- rows (private.space_material_ref_sync returns early for a Drive material).
--
-- * service_space_process_source — what `/process/start` needs in one read: the source as an
--   R2 file with a committed object, the destination folder (the root when none is named) and
--   the names already in it, so the output name is planned with the same pure rule a Drive run
--   uses (drive-ops/handler.ts buildUploadConflictPlan).
-- * service_space_process_upload — the output upload an operation opened, if any, for the
--   quiescence acknowledgement: the agent settled without a result, so the open session is
--   aborted and its reservation released.
-- * service_finalize_space_process_output — the agent's output upload is committed as a
--   material by service_complete_space_upload (20261226150000); this then records it as the
--   run's result in the same way a Drive finalize does: a `processed_from` link to the source,
--   the operation succeeded with the material (which releases the name reservation), and the
--   output's bytes counted under `process` in the space ledger (FR-047). A repeat returns the
--   same material with reused=true.
-- * private.space_material_category — a material that is a tool's output counts under
--   `process` while it is active; trash and task attachments keep their categories.
--
-- The output upload of an operation is bound to it by its idempotency key
-- `process_output_<operation id>` and ingress `agent_output`; the edge function builds that key
-- itself, the agent never names it.

create or replace function private.space_material_category(p_material uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when material.lifecycle <> 'active' then 'trash'
    when exists (select 1 from private.task_owned_uploads owned where owned.material_id = material.id) then 'attachments'
    when exists (
      select 1 from public.team_material_links link
      where link.derivative_material_id = material.id and link.team_id = material.team_id
        and link.relation = 'processed_from') then 'process'
    else 'materials' end
  from public.team_materials material where material.id = p_material;
$$;

create function public.service_space_process_source(
  p_team uuid, p_material uuid, p_destination uuid, p_actor uuid
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_source record;
  v_destination uuid;
begin
  perform private.require_space_actor(p_team, p_actor, 'process');
  select material.id, material.name, material.category, material.mime_type,
         object.byte_size, object.content_id
    into v_source
  from public.team_materials material
  join public.space_objects object on object.id = material.space_object_id and object.team_id = material.team_id
  where material.id = p_material and material.team_id = p_team and material.connection_id is null
    and material.kind = 'file' and material.lifecycle = 'active' and object.state = 'committed';
  if v_source.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_destination := private.space_live_folder(p_team, p_destination);
  if v_destination is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'materialId', v_source.id,
    'name', v_source.name,
    'category', v_source.category,
    'mimeType', v_source.mime_type,
    'sizeBytes', v_source.byte_size::text,
    'contentId', v_source.content_id,
    'destinationFolderId', v_destination,
    'childNames', coalesce((
      select jsonb_agg(child.name order by child.name)
      from public.team_materials child
      where child.team_id = p_team and child.connection_id is null
        and child.parent_folder_id = v_destination::text and child.lifecycle = 'active'), '[]'::jsonb));
end;
$$;

create function public.service_space_process_upload(p_operation uuid, p_actor uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o public.team_operations%rowtype;
  u public.space_uploads%rowtype;
begin
  select * into o from public.team_operations where id = p_operation and actor_id = p_actor;
  if not found or o.kind <> 'process' then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform private.require_space_actor(o.team_id, p_actor, 'process');
  select * into u from public.space_uploads
   where team_id = o.team_id and actor_id = p_actor and ingress = 'agent_output'
     and idempotency_key = 'process_output_' || p_operation::text;
  return jsonb_build_object(
    'operationState', o.state,
    'teamId', o.team_id,
    'uploadId', u.id,
    'uploadState', u.state);
end;
$$;

create function public.service_finalize_space_process_output(
  p_operation uuid, p_actor uuid, p_upload uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.team_operations%rowtype;
  i private.team_operation_intents%rowtype;
  u public.space_uploads%rowtype;
  v_source_name text;
  v_parent uuid;
begin
  select * into o from public.team_operations where id = p_operation and actor_id = p_actor for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if o.kind <> 'process' then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  if o.state = 'succeeded' then
    return jsonb_build_object('operationId', o.id, 'state', 'succeeded',
      'materialId', o.result_material_id, 'reused', true);
  end if;
  if o.state <> 'running' then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  perform 1 from public.teams where id = o.team_id for no key update;
  perform private.require_space_actor(o.team_id, p_actor, 'process');

  select * into i from private.team_operation_intents where operation_id = o.id;
  if not found or i.tool_id is null or i.version_of_material_id is not null or o.source_material_id is null then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;

  select * into u from public.space_uploads
   where id = p_upload and team_id = o.team_id and actor_id = p_actor and ingress = 'agent_output'
     and idempotency_key = 'process_output_' || o.id::text
   for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if u.state <> 'committed' or u.result_material_id is null then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;

  select material.name into v_source_name from public.team_materials material
   where material.id = o.source_material_id and material.team_id = o.team_id;
  insert into public.team_material_links (
    team_id, source_material_id, derivative_material_id, relation, source_name_snapshot,
    tool_id, tool_contract_version, created_by)
  values (
    o.team_id, o.source_material_id, u.result_material_id, 'processed_from',
    coalesce(v_source_name, u.name), i.tool_id, i.tool_contract_version, p_actor)
  on conflict (team_id, source_material_id, derivative_material_id, relation) do nothing;
  perform private.space_material_ref_sync(u.result_material_id);

  perform public.service_transition_team_operation(
    o.id, 'succeeded', 'completed', 100, u.result_material_id, null, false);

  select (material.parent_folder_id)::uuid into v_parent from public.team_materials material
   where material.id = u.result_material_id;
  perform private.space_content_changed(o.team_id, v_parent, true);
  return jsonb_build_object('operationId', o.id, 'state', 'succeeded',
    'materialId', u.result_material_id, 'reused', false);
end;
$$;

revoke all on function private.space_material_category(uuid) from public, anon, authenticated;
revoke all on function public.service_space_process_source(uuid, uuid, uuid, uuid),
  public.service_space_process_upload(uuid, uuid),
  public.service_finalize_space_process_output(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.service_space_process_source(uuid, uuid, uuid, uuid),
  public.service_space_process_upload(uuid, uuid),
  public.service_finalize_space_process_output(uuid, uuid, uuid)
  to service_role;
