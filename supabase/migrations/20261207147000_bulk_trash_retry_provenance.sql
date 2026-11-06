-- Retain unknown historical writes; issue a fresh key only after proved preflight refusal.
begin;
create or replace function public.service_fail_drive_mutation_preflight(
 p_operation uuid,p_actor uuid,p_error_code text,p_retryable boolean default false
) returns boolean language plpgsql security definer set search_path='' as $$
declare operation_row public.team_operations%rowtype;
begin
 if p_error_code is null or p_error_code not in (
  'AUTH_REQUIRED','PERMISSION_DENIED','NOT_FOUND','ROOT_ESCAPE','UNSUPPORTED_MEDIA',
  'INVALID_INPUT','INVALID_RESPONSE','NEEDS_REAUTH','DRIVE_UNAVAILABLE','RATE_LIMITED','SPACE_BLOCKED'
 ) then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 select * into operation_row from public.team_operations
 where id=p_operation and actor_id=p_actor for update;
 if not found or operation_row.kind not in ('trash','restore')
   or not private.can(operation_row.team_id,'delete',p_actor)
 then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if operation_row.state<>'pending' or exists(
   select 1 from private.team_material_group_intents where operation_id=p_operation
 ) then return false; end if;
 return public.service_transition_team_operation(
   p_operation,'failed','preflight_refused',100,null,p_error_code,coalesce(p_retryable,false)
 );
end $$;

create or replace function public.prepare_team_bulk_trash_item(p_team uuid,p_group uuid,p_material uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g private.team_bulk_trash_groups%rowtype; i private.team_bulk_trash_items%rowtype; o public.team_operations%rowtype;
begin
 if auth.uid() is null or not private.can(p_team,'delete',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 select * into g from private.team_bulk_trash_groups where id=p_group and team_id=p_team and actor_id=auth.uid();
 if g.id is null then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 select * into i from private.team_bulk_trash_items where group_id=p_group and material_id=p_material for update;
 if i.group_id is null then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
 select * into o from public.team_operations where team_id=p_team and actor_id=g.actor_id and kind='trash' and idempotency_key=i.idempotency_key for update;
 -- A historical terminal alone is not evidence of provider quiescence.
 -- Only the locked fresh metadata-preflight sink may create this provenance.
 if o.state in ('failed','canceled') then
  if o.state<>'failed' or o.stage is distinct from 'preflight_refused'
    or o.source_material_id is distinct from p_material
    or o.error_code is null or o.error_code not in (
      'AUTH_REQUIRED','PERMISSION_DENIED','NOT_FOUND','ROOT_ESCAPE','UNSUPPORTED_MEDIA',
      'INVALID_INPUT','INVALID_RESPONSE','NEEDS_REAUTH','DRIVE_UNAVAILABLE','RATE_LIMITED','SPACE_BLOCKED'
    ) or exists(select 1 from private.team_material_group_intents where operation_id=o.id)
  then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000'; end if;
  if i.attempt>=10 then raise exception 'WRONG_STATE' using errcode='55000'; end if;
 update private.team_bulk_trash_items set attempt=attempt+1,idempotency_key=p_group::text||':'||p_material::text||':'||(attempt+1)::text,error_code=null,requested_at=null where group_id=p_group and material_id=p_material;
 end if;
 return private.bulk_trash_snapshot(p_group);
end $$;

-- CREATE OR REPLACE preserves the existing restricted function grants.
commit;
