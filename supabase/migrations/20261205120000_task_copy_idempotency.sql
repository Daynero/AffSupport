begin;
create table private.team_task_copy_receipts (
  team_id uuid not null references public.teams(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  source_ids uuid[] not null,
  result_ids uuid[] not null,
  created_at timestamptz not null default now(),
  primary key(team_id, actor_id, request_id)
);
alter table private.team_task_copy_receipts enable row level security;
alter table private.team_task_copy_receipts force row level security;
revoke all on private.team_task_copy_receipts from public, anon, authenticated;
create function public.copy_team_tasks_once(p_team uuid, p_tasks uuid[], p_request uuid)
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); receipt private.team_task_copy_receipts%rowtype; result uuid[];
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  if p_request is null or p_tasks is null or cardinality(p_tasks) not between 1 and 100
    or array_position(p_tasks,null) is not null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text || actor::text || p_request::text, 0));
  select * into receipt from private.team_task_copy_receipts where team_id=p_team and actor_id=actor and request_id=p_request;
  if found then
    if receipt.source_ids <> p_tasks then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
    return receipt.result_ids;
  end if;
  result := public.copy_team_tasks(p_team,p_tasks);
  insert into private.team_task_copy_receipts(team_id,actor_id,request_id,source_ids,result_ids)
    values(p_team,actor,p_request,p_tasks,result);
  return result;
end $$;
revoke all on function public.copy_team_tasks_once(uuid,uuid[],uuid) from public,anon;
grant execute on function public.copy_team_tasks_once(uuid,uuid[],uuid) to authenticated;
commit;
