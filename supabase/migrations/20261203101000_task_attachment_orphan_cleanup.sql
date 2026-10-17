-- Task-drop provenance is the exact successful upload operation, never folder
-- location or a material name. Cleanup remains separate from detachment.
create table private.team_task_upload_markers (
  team_id uuid not null,
  material_id uuid not null,
  operation_id uuid not null unique,
  marked_by uuid not null,
  marked_at timestamptz not null default clock_timestamp(),
  primary key (team_id, material_id),
  foreign key (material_id, team_id) references public.team_materials(id, team_id),
  foreign key (operation_id, team_id) references public.team_operations(id, team_id)
);
revoke all on private.team_task_upload_markers from public, anon, authenticated;

create table private.team_task_orphan_intents (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null,
  task_id uuid not null,
  material_id uuid not null,
  detached_by uuid not null,
  detached_at timestamptz not null,
  cleanup_not_before timestamptz not null,
  state text not null check (state in ('waiting','cleanup_unverified','claimed','confirmed_in_trash','failed','cancelled')),
  reason_code text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  lease_until timestamptz,
  operation_id uuid,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (material_id, team_id) references public.team_materials(id, team_id),
  unique (team_id, task_id, material_id, detached_at)
);
create index team_task_orphan_due_idx on private.team_task_orphan_intents(cleanup_not_before)
  where state in ('waiting','claimed');
revoke all on private.team_task_orphan_intents from public, anon, authenticated;

create function public.mark_team_task_upload(p_team uuid, p_task uuid, p_material uuid, p_operation uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  if not exists (select 1 from public.team_task_attachments a
    where a.team_id=p_team and a.task_id=p_task and a.material_id=p_material)
    or not exists (select 1 from public.team_operations o
      where o.id=p_operation and o.team_id=p_team and o.actor_id=actor
        and o.kind='upload' and o.state='succeeded' and o.result_material_id=p_material)
  then raise exception 'UNVERIFIED_UPLOAD' using errcode='22023'; end if;
  insert into private.team_task_upload_markers(team_id,material_id,operation_id,marked_by)
    values (p_team,p_material,p_operation,actor)
    on conflict (team_id,material_id) do nothing;
  return exists (select 1 from private.team_task_upload_markers m
    where m.team_id=p_team and m.material_id=p_material and m.operation_id=p_operation);
end $$;
revoke all on function public.mark_team_task_upload(uuid,uuid,uuid,uuid) from public, anon;
grant execute on function public.mark_team_task_upload(uuid,uuid,uuid,uuid) to authenticated;

create function public.detach_team_task_material_v2(p_team uuid,p_task uuid,p_material uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  detached_at timestamptz;
  deadline timestamptz;
  intent_state text;
  intent_id uuid;
begin
  if actor is null or not private.can(p_team,'edit',actor) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  perform 1 from public.team_materials m where m.id=p_material and m.team_id=p_team for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  delete from public.team_task_attachments a
    where a.team_id=p_team and a.task_id=p_task and a.material_id=p_material;
  if not found then
    return jsonb_build_object('detached',false,'state','already_detached');
  end if;
  detached_at := clock_timestamp();
  deadline := detached_at + interval '30 seconds';
  intent_state := case when exists(select 1 from private.team_task_upload_markers m
    where m.team_id=p_team and m.material_id=p_material) then 'waiting' else 'cleanup_unverified' end;
  insert into private.team_task_orphan_intents
    (team_id,task_id,material_id,detached_by,detached_at,cleanup_not_before,state,reason_code)
    values (p_team,p_task,p_material,actor,detached_at,deadline,intent_state,
      case when intent_state='waiting' then null else 'PROVENANCE_UNKNOWN' end)
    returning id into intent_id;
  return jsonb_build_object('detached',true,'state',intent_state,'intentId',intent_id,
    'detachedAt',detached_at,'undoDeadline',deadline);
end $$;
revoke all on function public.detach_team_task_material_v2(uuid,uuid,uuid) from public, anon;
grant execute on function public.detach_team_task_material_v2(uuid,uuid,uuid) to authenticated;

create function private.cancel_task_orphan_on_attach() returns trigger
language plpgsql set search_path = '' as $$
begin
  update private.team_task_orphan_intents i set state='cancelled',
    reason_code='REATTACHED', updated_at=clock_timestamp()
    where i.team_id=new.team_id and i.material_id=new.material_id
      and i.state in ('waiting','cleanup_unverified','claimed');
  return new;
end $$;
create trigger cancel_task_orphan_on_attach after insert on public.team_task_attachments
for each row execute function private.cancel_task_orphan_on_attach();
