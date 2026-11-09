-- Immutable acceptance receipts for manager Run/Retry clicks, separate from provider delivery.
begin;
create table private.team_catalog_update_commands (
  id uuid primary key,
  team_id uuid not null references public.teams(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('run','retry')),
  catalog_ids uuid[] not null check (cardinality(catalog_ids) between 1 and 500),
  source_attempt_id uuid,
  receipt jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  check ((kind='retry') = (source_attempt_id is not null))
);
-- Receipts contain material identities in arrays/JSON. Participate in the existing
-- conservative reference inventory and the fence against late cleanup references.
create trigger task_cleanup_reference_fence before insert or update
 on private.team_catalog_update_commands for each row
 execute function private.guard_task_cleanup_reference();
alter table private.team_catalog_update_commands enable row level security;
alter table private.team_catalog_update_commands force row level security;
revoke all on private.team_catalog_update_commands from public, anon, authenticated, service_role;
alter table public.team_catalog_update_attempts add column command_id uuid
  references private.team_catalog_update_commands(id) on delete set null;
create index catalog_update_attempt_command_idx on public.team_catalog_update_attempts(command_id);

create function public.request_team_catalog_update_command(
  p_team uuid, p_command uuid, p_catalogs uuid[], p_expected_actor uuid, p_source_attempt uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid := auth.uid();
  wanted uuid[];
  previous private.team_catalog_update_commands%rowtype;
  before_rows jsonb;
  items jsonb;
  receipt jsonb;
  opened integer;
  bound_count integer;
begin
  if actor is null or p_expected_actor is distinct from actor or not private.can(p_team,'process',actor) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  if p_command is null or p_catalogs is null or cardinality(p_catalogs) not between 1 and 500
     or array_position(p_catalogs,null) is not null then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  select array_agg(id order by id) into wanted from (select distinct unnest(p_catalogs) id) ids;
  if p_source_attempt is not null and cardinality(wanted)<>1 then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  -- A command replay is serialized even before its catalog rows exist.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_command::text,47));
  select * into previous from private.team_catalog_update_commands where id=p_command;
  if found then
    if previous.team_id<>p_team or previous.actor_id<>actor or previous.catalog_ids<>wanted
       or previous.source_attempt_id is distinct from p_source_attempt then
      raise exception 'INVALID_INPUT' using errcode='22023';
    end if;
    return previous.receipt;
  end if;
  perform private.checked_catalogs(p_team,wanted);
  insert into public.team_catalog_updaters(team_id) values(p_team) on conflict(team_id) do nothing;
  -- Same lock order as the existing scheduler/manual writer.
  perform 1 from public.team_catalog_updaters where team_id=p_team for update;
  insert into public.team_catalog_updater_items(catalog_material_id,team_id)
    select id,p_team from unnest(wanted) id on conflict(catalog_material_id) do nothing;
  select jsonb_object_agg(item.catalog_material_id::text,jsonb_build_object(
    'round',item.round_due_at,'reconciliation',item.reconciliation_required))
    into before_rows from public.team_catalog_updater_items item
    where item.team_id=p_team and item.catalog_material_id=any(wanted);
  if p_source_attempt is null then
    opened := public.run_team_catalog_update_now(p_team,wanted);
  else
    opened := public.retry_team_catalog_update(p_team,wanted[1],p_source_attempt);
  end if;
  select jsonb_agg(jsonb_build_object(
    'catalogId', wanted_id,
    'accepted', before_rows->wanted_id::text->>'round' is null and item.round_due_at is not null,
    'attemptId', attempt.attempt_id,
    'reason', case
      when before_rows->wanted_id::text->>'round' is null and item.round_due_at is not null then 'accepted'
      when coalesce(item.reconciliation_required,(before_rows->wanted_id::text->>'reconciliation')::boolean,false)
        or exists(select 1 from private.catalog_update_reconciliations pending where pending.catalog_material_id=wanted_id) then 'reconciliation_required'
      else 'already_pending' end
  ) order by wanted_id)
  into items from unnest(wanted) wanted_id
  left join public.team_catalog_updater_items item
    on item.team_id=p_team and item.catalog_material_id=wanted_id
  left join public.team_catalog_update_attempts attempt
    on attempt.catalog_material_id=item.catalog_material_id and attempt.round_due_at=item.round_due_at
  ;
  select count(*) into bound_count from jsonb_array_elements(items) entry
    where (entry->>'accepted')::boolean and entry->>'attemptId' is not null;
  if bound_count<>opened or jsonb_array_length(items)<>cardinality(wanted) then
    raise exception 'INVALID_RESPONSE' using errcode='22023';
  end if;
  receipt := jsonb_build_object('commandId',p_command,
    'kind',case when p_source_attempt is null then 'run' else 'retry' end,'status','accepted',
    'sourceAttemptId',p_source_attempt,'requestedCount',cardinality(wanted),
    'acceptedCount',opened,'items',items);
  insert into private.team_catalog_update_commands(id,team_id,actor_id,kind,catalog_ids,source_attempt_id,receipt)
    values(p_command,p_team,actor,case when p_source_attempt is null then 'run' else 'retry' end,
      wanted,p_source_attempt,receipt);
  update public.team_catalog_update_attempts attempt set command_id=p_command
  from jsonb_array_elements(items) entry
  where (entry->>'accepted')::boolean and attempt.attempt_id=(entry->>'attemptId')::uuid
    and attempt.catalog_material_id=(entry->>'catalogId')::uuid and attempt.team_id=p_team;
  get diagnostics bound_count=row_count;
  if bound_count<>opened then raise exception 'INVALID_RESPONSE' using errcode='22023'; end if;
  return receipt;
end $$;

-- This seals an unobserved request rather than guessing that a timeout cancelled it.
-- If the original transaction already accepted it, return its exact immutable receipt.
create function public.cancel_team_catalog_command_intent(
  p_team uuid,p_command uuid,p_catalogs uuid[],p_expected_actor uuid,p_source_attempt uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); wanted uuid[]; previous private.team_catalog_update_commands%rowtype;
  receipt jsonb;
begin
  if actor is null or p_expected_actor is distinct from actor or not private.can(p_team,'process',actor) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  if p_command is null or p_catalogs is null or cardinality(p_catalogs) not between 1 and 500
     or array_position(p_catalogs,null) is not null then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  select array_agg(id order by id) into wanted from (select distinct unnest(p_catalogs) id) ids;
  if p_source_attempt is not null and cardinality(wanted)<>1 then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_command::text,47));
  select * into previous from private.team_catalog_update_commands where id=p_command;
  if found then
    if previous.team_id<>p_team or previous.actor_id<>actor or previous.catalog_ids<>wanted
       or previous.source_attempt_id is distinct from p_source_attempt then
      raise exception 'INVALID_INPUT' using errcode='22023';
    end if;
    return previous.receipt;
  end if;
  -- No provider mutation: a late executor sees this terminal tombstone and cannot start work.
  receipt:=jsonb_build_object('commandId',p_command,
    'kind',case when p_source_attempt is null then 'run' else 'retry' end,
    'status','cancelled','sourceAttemptId',p_source_attempt,'requestedCount',cardinality(wanted),
    'acceptedCount',0,'items',(select jsonb_agg(jsonb_build_object(
      'catalogId',id,'accepted',false,'attemptId',null,'reason','cancelled_before_acceptance'
    ) order by id) from unnest(wanted) id));
  insert into private.team_catalog_update_commands(id,team_id,actor_id,kind,catalog_ids,source_attempt_id,receipt)
    values(p_command,p_team,actor,case when p_source_attempt is null then 'run' else 'retry' end,
      wanted,p_source_attempt,receipt);
  return receipt;
end $$;
revoke all on function public.cancel_team_catalog_command_intent(uuid,uuid,uuid[],uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.cancel_team_catalog_command_intent(uuid,uuid,uuid[],uuid,uuid)
  to authenticated;

create function public.get_team_catalog_update_command(p_team uuid,p_command uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not private.can(p_team,'view',auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  -- Null is absence of observed commit, never evidence that a pending write cannot commit.
  return (select receipt from private.team_catalog_update_commands
    where id=p_command and team_id=p_team and actor_id=auth.uid());
end $$;
revoke all on function public.request_team_catalog_update_command(uuid,uuid,uuid[],uuid,uuid),
  public.get_team_catalog_update_command(uuid,uuid) from public,anon,authenticated;
grant execute on function public.request_team_catalog_update_command(uuid,uuid,uuid[],uuid,uuid),
  public.get_team_catalog_update_command(uuid,uuid) to authenticated;

create view public.analytics_catalog_commands as
select command.id command_id,command.team_id,command.actor_id,command.kind,
  command.source_attempt_id,command.created_at,command.receipt->>'status' status,
  (item->>'catalogId')::uuid catalog_id,(item->>'attemptId')::uuid attempt_id,
  (item->>'accepted')::boolean accepted,item->>'reason' reason
from private.team_catalog_update_commands command
cross join lateral jsonb_array_elements(command.receipt->'items') item;
revoke all on public.analytics_catalog_commands from public,anon,authenticated;
create view public.analytics_catalog_command_bindings as
select attempt_id,command_id from public.team_catalog_update_attempts where command_id is not null;
revoke all on public.analytics_catalog_command_bindings from public,anon,authenticated,service_role;
do $$ begin
  if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
    grant select on public.analytics_catalog_commands,public.analytics_catalog_command_bindings to wishly_analytics_ro;
  end if;
end $$;
commit;
