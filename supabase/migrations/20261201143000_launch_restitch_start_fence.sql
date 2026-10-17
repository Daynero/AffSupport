-- A delayed browser request cannot start a child after its Launch was cancelled.
create function private.guard_launch_restitch_start() returns trigger language plpgsql security definer set search_path='' as $$
declare generation uuid;g public.team_launch_generations%rowtype;l public.team_launches%rowtype;
 preparation private.launch_restitch_preparations%rowtype;r public.team_launch_revisions%rowtype;
begin
 if new.idempotency_key not like 'launch-restitch:%' then return new;end if;
 if new.idempotency_key !~ '^launch-restitch:[0-9a-f-]{36}:[1-9][0-9]{0,2}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 generation:=split_part(new.idempotency_key,':',2)::uuid;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=generation and team_id=new.team_id) for update;
 select * into g from public.team_launch_generations where id=generation and team_id=new.team_id for update;
 select * into preparation from private.launch_restitch_preparations where generation_id=generation;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 if g.id is null or l.id is null or l.archived_at is not null or preparation.generation_id is null
  or g.state<>'waiting_dependency' or new.actor_id<>g.actor_id or new.kind<>'process'
  or new.source_material_id is distinct from (r.config->>'materialId')::uuid
  or new.idempotency_key<>preparation.process_key then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return new;
end $$;
create trigger team_operations_launch_restitch_start_guard before insert on public.team_operations
 for each row execute function private.guard_launch_restitch_start();
revoke all on function private.guard_launch_restitch_start() from public,anon,authenticated;
