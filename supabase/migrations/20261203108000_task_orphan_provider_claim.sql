-- A task-owned upload may be moved to Drive trash only after its grace period
-- and after the database has accounted for every known consumer of the file.
-- Unknown ownership or an unavailable Launches schema is a retained outcome.
alter table private.team_task_orphan_intents add column lease_owner text;

create function private.task_orphan_reference_reason(p_team uuid, p_material uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare file public.team_materials%rowtype;
begin
  select * into file from public.team_materials m
    where m.id=p_material and m.team_id=p_team;
  if file.id is null or file.kind <> 'file' or file.lifecycle <> 'active'
      or nullif(file.drive_file_id,'') is null then return 'MATERIAL_UNVERIFIED'; end if;
  if to_regclass('public.team_launches') is null
      or to_regclass('public.team_launch_revisions') is null
      or to_regclass('public.team_launch_revision_catalogs') is null
      or to_regclass('public.team_launch_generation_steps') is null
  then return 'LAUNCH_REFERENCE_UNVERIFIED'; end if;
  -- New material-shaped columns are an inventory change. Retain the file until
  -- the reference query and its write fence have been reviewed together.
  if (select md5(string_agg(n.nspname||'.'||c.relname||'.'||a.attname,','
      order by n.nspname,c.relname,a.attname))
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid=a.attrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind='r'
      and a.atttypid='uuid'::regtype and a.attnum>0 and not a.attisdropped
      and (a.attname like '%material%' or a.attname like '%file%'
        or a.attname like '%catalog%'))
      <> '0eb69bf78f2b4bc5f6e36ce11644b388'
  then return 'REFERENCE_INVENTORY_UNVERIFIED'; end if;
  if not exists (
    select 1 from private.team_task_upload_markers marker
    join public.team_operations operation
      on operation.id=marker.operation_id and operation.team_id=marker.team_id
    where marker.team_id=p_team and marker.material_id=p_material
      and operation.kind='upload' and operation.state='succeeded'
      and operation.result_material_id=p_material
  ) then return 'PROVENANCE_UNKNOWN'; end if;
  if exists(select 1 from public.team_task_attachments a where a.material_id=p_material)
    or exists(select 1 from public.team_material_links l
      where l.source_material_id=p_material or l.derivative_material_id=p_material)
    or exists(select 1 from public.team_materials m
      where m.companion_of=p_material and m.lifecycle='active')
    or exists(select 1 from public.team_materials m
      where m.team_id=p_team and m.shortcut_target_id=file.drive_file_id
        and m.lifecycle='active')
    or exists(select 1 from public.team_library_requirements r
      where r.source_material_id=p_material)
    or exists(select 1 from public.team_library_results r
      where r.source_material_id=p_material or r.material_id=p_material)
    or exists(select 1 from public.team_product_catalog_image_sources s
      where s.material_id=p_material)
    or exists(select 1 from public.team_restitch_sources s where s.material_id=p_material)
    or exists(select 1 from public.team_product_catalogs c
      where c.material_id=p_material or c.video_material_id=p_material
        or position(file.drive_file_id in coalesce(c.video_link,'')) > 0
        or position(file.drive_file_id in coalesce(c.current_video_link,'')) > 0)
    or exists(select 1 from public.team_catalog_restitch_copies c
      where c.material_id=p_material or c.catalog_material_id=p_material)
    or exists(select 1 from private.catalog_generation_intents g
      where g.team_id=p_team and
        (g.video_material_id=p_material or g.replaces_material_id=p_material))
    or exists(select 1 from public.team_landing_renders r where r.material_id=p_material)
    or exists(select 1 from private.team_transfer_grants g
      where g.material_id=p_material and g.revoked_at is null
        and g.expires_at>clock_timestamp())
    or exists(select 1 from public.team_material_restitch_prep r where r.material_id=p_material)
    or exists(select 1 from private.team_material_group_intents g
      where g.source_material_id=p_material and g.state not in ('completed','failed','cancelled'))
    or exists(select 1 from public.team_operations o
      where o.source_material_id=p_material and o.state in ('pending','running'))
    or exists(select 1 from public.team_launches l
      where l.team_id=p_team and l.archived_at is null
        and (l.draft_config->>'materialId'=p_material::text
          or l.expected_source_snapshot->>'materialId'=p_material::text))
    or exists(select 1 from public.team_launch_revisions r
      where r.team_id=p_team and
        (r.config->>'materialId'=p_material::text or r.sources->>'materialId'=p_material::text))
    or exists(select 1 from public.team_launch_revision_catalogs c
      where c.team_id=p_team and
        (c.material_id=p_material or c.restitch_material_id=p_material))
    or exists(select 1 from public.team_launch_generation_steps s
      where s.team_id=p_team and s.result_material_id=p_material)
  then return 'MATERIAL_REFERENCED'; end if;
  return null;
end $$;
revoke all on function private.task_orphan_reference_reason(uuid,uuid)
  from public, anon, authenticated;

create function public.service_claim_task_orphan_cleanups(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 120
)
returns table(intent_id uuid, material_id uuid, drive_file_id text,
  resource_key text, credential_id uuid)
language plpgsql security definer set search_path = '' as $$
declare item private.team_task_orphan_intents%rowtype;
  file public.team_materials%rowtype; reason text; credential uuid;
begin
  if p_worker is null or length(p_worker) not between 8 and 160 then
    raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  for item in select * from private.team_task_orphan_intents i
    where i.cleanup_not_before <= clock_timestamp() and i.attempt_count < 20
      and (i.state='waiting' or
        (i.state='claimed' and (i.lease_until is null or i.lease_until <= clock_timestamp())))
    order by i.cleanup_not_before,i.id for update skip locked
    limit least(greatest(coalesce(p_limit,10),1),10)
  loop
    select * into file from public.team_materials m
      where m.id=item.material_id and m.team_id=item.team_id for update;
    reason := private.task_orphan_reference_reason(item.team_id,item.material_id);
    if reason is null and exists(select 1 from private.team_task_orphan_intents other
      where other.material_id=item.material_id and other.id<>item.id and other.state='claimed')
    then reason := 'DUPLICATE_CLAIM'; end if;
    if reason is not null then
      update private.team_task_orphan_intents i set state='cleanup_unverified',
        reason_code=reason,lease_owner=null,lease_until=null,updated_at=clock_timestamp()
        where i.id=item.id;
      continue;
    end if;
    select connection.credential_id into credential
      from public.team_drive_connections connection
      where connection.id=file.connection_id and connection.team_id=item.team_id
        and connection.state='connected';
    if credential is null then
      update private.team_task_orphan_intents i set state='cleanup_unverified',
        reason_code='CONNECTION_UNVERIFIED',lease_owner=null,lease_until=null,
        updated_at=clock_timestamp() where i.id=item.id;
      continue;
    end if;
    update private.team_task_orphan_intents i set state='claimed',
      reason_code=null,lease_owner=p_worker,
      lease_until=clock_timestamp()+make_interval(secs=>least(greatest(coalesce(p_lease_seconds,120),30),300)),
      attempt_count=i.attempt_count+1,updated_at=clock_timestamp()
      where i.id=item.id;
    intent_id:=item.id;material_id:=item.material_id;drive_file_id:=file.drive_file_id;
    resource_key:=file.resource_key;credential_id:=credential;return next;
  end loop;
end $$;
revoke all on function public.service_claim_task_orphan_cleanups(text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.service_claim_task_orphan_cleanups(text,integer,integer)
  to service_role;

create function public.service_complete_task_orphan_cleanup(
  p_intent uuid,p_worker text,p_provider_trashed boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare item private.team_task_orphan_intents%rowtype; reason text;
begin
  select * into item from private.team_task_orphan_intents i
    where i.id=p_intent for update;
  if item.id is null or item.state<>'claimed' or item.lease_owner is distinct from p_worker
      or item.lease_until<=clock_timestamp() then return false; end if;
  if not p_provider_trashed then
    update private.team_task_orphan_intents i set
      state=case when i.attempt_count>=20 then 'failed' else 'waiting' end,
      reason_code='DRIVE_UNAVAILABLE',lease_owner=null,lease_until=null,
      cleanup_not_before=clock_timestamp()+make_interval(secs=>
        case when i.attempt_count<3 then 60 else 300 end),
      updated_at=clock_timestamp() where i.id=p_intent;
    return false;
  end if;
  perform 1 from public.team_materials m where m.id=item.material_id for update;
  reason:=private.task_orphan_reference_reason(item.team_id,item.material_id);
  if reason is not null then
    update private.team_task_orphan_intents i set state='cleanup_unverified',
      reason_code=reason,lease_owner=null,lease_until=null,updated_at=clock_timestamp()
      where i.id=p_intent;
    return false;
  end if;
  update public.team_materials m set lifecycle='trashed',trashed_at=clock_timestamp(),
    updated_at=clock_timestamp() where m.id=item.material_id and m.lifecycle='active';
  update private.team_task_orphan_intents i set state='confirmed_in_trash',
    reason_code=null,lease_owner=null,lease_until=null,updated_at=clock_timestamp()
    where i.id=p_intent;
  insert into public.team_catalog_events(team_id,material_id,event_kind)
    values(item.team_id,item.material_id,'tombstoned');
  return true;
end $$;
revoke all on function public.service_complete_task_orphan_cleanup(uuid,text,boolean)
  from public, anon, authenticated;
grant execute on function public.service_complete_task_orphan_cleanup(uuid,text,boolean)
  to service_role;
