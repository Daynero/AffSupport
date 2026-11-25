-- 072 (П3, П6): a catalog never hangs in silence.
--
-- Production 2026-11-25: a publication sat `blocked/target_unavailable` for a day after its
-- Drive came back, and nothing on the page said so or could move it — the dialog kept saying
-- «Публікуємо посилання…». Catalog creation, for its part, could be started against a paused
-- space or a disconnected Drive and failed with a sentence about something else, and a creation
-- whose background work never picked it up said only «0 з N».
--
-- Additive only:
--   1. public.retry_team_catalog_publication — «Опублікувати ще раз» for a blocked job, checked
--      the way the neighbouring publication functions check (process permission, live catalog,
--      current policy revision). An undispatched job goes back into the queue as it is; one the
--      writer already touched is answered `republish`, and the page saves a new immediate
--      revision through the existing action, which supersedes it.
--   2. A trigger on team_drive_connections: a connection that returns to `connected` puts the
--      publications it had blocked as `target_unavailable` back into the queue.
--   3. The same requeue, once, for jobs already blocked on a connection that is connected now.
--   4. public.team_catalog_creation_preflight — what creation would refuse, asked before it is
--      started: a paused space, a disconnected Drive, no background executor for restitch.
--   5. service_read_initial_catalog_video says why a creation's videos have not started:
--      `waitReason` (AGENT_REQUIRED, NEEDS_REAUTH) and `backgroundStalled`, as the manager's
--      registry already does for update rounds.

-- 1. Publish again --------------------------------------------------------------------------

create or replace function public.retry_team_catalog_publication(p_team uuid, p_catalog uuid, p_job uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  j private.catalog_video_publication_jobs%rowtype;
  p private.catalog_video_publication_policies%rowtype;
begin
  if actor is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_team is null or p_catalog is null or p_job is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- A member of a paused space is told so, not «no permission» (audit #14).
  if not private.team_workspace_allowed(p_team)
     and exists (select 1 from public.team_members m
                 where m.team_id = p_team and m.user_id = actor and m.removed_at is null) then
    raise exception 'SPACE_BLOCKED' using errcode = '42501';
  end if;
  if private.can(p_team, 'process', actor) is not true then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform 1 from public.team_materials m
    join public.team_product_catalogs c on c.material_id = m.id
   where m.id = p_catalog and m.team_id = p_team and m.lifecycle = 'active'
   for update of m;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into p from private.catalog_video_publication_policies
   where catalog_material_id = p_catalog and team_id = p_team for update;
  select * into j from private.catalog_video_publication_jobs
   where id = p_job and catalog_material_id = p_catalog and team_id = p_team for update;
  if j.id is null or p.catalog_material_id is null or j.revision <> p.revision then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  -- A second press, or a job the trigger already returned: nothing to do, and it says so.
  if j.state <> 'blocked' then
    return jsonb_build_object('outcome', case when j.state in ('published', 'superseded', 'held')
                                              then 'settled' else 'queued' end,
                              'state', j.state);
  end if;
  -- These have their own way out (verification, a new time, the writer's rollout).
  if p.mode = 'held' or j.blocked_reason in ('legacy_adoption_required', 'writer_unsupported', 'invalid_due') then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  if not private.catalog_connection_usable(p_catalog) then
    raise exception 'NEEDS_REAUTH' using errcode = '55000';
  end if;
  -- Touched by a writer, or owned by someone who may no longer write: a new revision under the
  -- person pressing, through the established action, instead of reviving this one.
  if j.dispatched_at is not null or j.writer_fence is not null
     or private.catalog_publication_job_actor_allowed(j.id) is not true then
    return jsonb_build_object('outcome', 'republish', 'state', j.state);
  end if;
  update private.catalog_video_publication_jobs
     set state = 'retry_wait', blocked_reason = null, worker_id = null, lease_until = null,
         next_attempt_at = clock_timestamp(), validation_epoch_started_at = null,
         preparation_error_code = null, preparation_error_at = null
   where id = j.id;
  insert into public.team_catalog_events(team_id, material_id, event_kind)
  values (p_team, p_catalog, 'upserted');
  return jsonb_build_object('outcome', 'requeued', 'state', 'retry_wait');
end;
$$;

revoke all on function public.retry_team_catalog_publication(uuid, uuid, uuid) from public, anon;
grant execute on function public.retry_team_catalog_publication(uuid, uuid, uuid) to authenticated;

-- 2 + 3. Drive came back ----------------------------------------------------------------------

create or replace function private.requeue_catalog_publications_for_connection(p_team uuid, p_connection uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  with requeued as (
    update private.catalog_video_publication_jobs j
       set state = 'retry_wait', blocked_reason = null, worker_id = null, lease_until = null,
           next_attempt_at = clock_timestamp(), validation_epoch_started_at = null,
           preparation_error_code = null, preparation_error_at = null
      from private.catalog_video_publication_policies p, public.team_materials m
     where p.catalog_material_id = j.catalog_material_id and p.revision = j.revision and p.mode <> 'held'
       and m.id = j.catalog_material_id and m.team_id = j.team_id and m.lifecycle = 'active'
       and m.connection_id = p_connection
       and j.team_id = p_team and j.state = 'blocked' and j.blocked_reason = 'target_unavailable'
       and j.dispatched_at is null and j.writer_fence is null
    returning j.team_id, j.catalog_material_id
  ), events as (
    insert into public.team_catalog_events(team_id, material_id, event_kind)
    select distinct team_id, catalog_material_id, 'upserted' from requeued
    returning 1
  )
  select count(*)::integer into n from requeued;
  return n;
end;
$$;

revoke all on function private.requeue_catalog_publications_for_connection(uuid, uuid) from public, anon, authenticated;

create or replace function private.team_drive_connection_requeue_catalog_publications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Reconnecting Drive must never fail because of a publication; the jobs stay blocked
  -- and «Опублікувати ще раз» is still there.
  begin
    perform private.requeue_catalog_publications_for_connection(new.team_id, new.id);
  exception when others then
    raise warning 'catalog publication requeue skipped: %', sqlstate;
  end;
  return null;
end;
$$;

revoke all on function private.team_drive_connection_requeue_catalog_publications() from public, anon, authenticated;

drop trigger if exists team_drive_connections_requeue_catalog_publications on public.team_drive_connections;
create trigger team_drive_connections_requeue_catalog_publications
  after update of state on public.team_drive_connections
  for each row
  when (old.state is distinct from new.state and new.state = 'connected')
  execute function private.team_drive_connection_requeue_catalog_publications();

-- Jobs blocked while Drive was away, on a connection that is already back.
select private.requeue_catalog_publications_for_connection(c.team_id, c.id)
  from public.team_drive_connections c
 where c.state = 'connected';

-- 4. Before a catalog is created --------------------------------------------------------------

create or replace function public.team_catalog_creation_preflight(p_team uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  drive text;
begin
  if actor is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_team is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  -- Membership, not can(): a paused space answers can() = false for everyone, and the point
  -- is to say that it is paused.
  if not exists (select 1 from public.team_members m
                 where m.team_id = p_team and m.user_id = actor and m.removed_at is null) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select c.state into drive from public.team_drive_connections c
   where c.team_id = p_team
   order by (c.state = 'connected') desc, c.updated_at desc
   limit 1;
  return jsonb_build_object(
    'spaceAllowed', private.team_workspace_allowed(p_team),
    'driveState', coalesce(drive, 'none'),
    'canCreate', coalesce(private.can(p_team, 'view', actor) and private.can(p_team, 'upload', actor), false),
    'canRestitch', coalesce(private.can(p_team, 'process', actor), false),
    'backgroundExecutor', private.recovery_executor_for(p_team, actor) is not null
  );
end;
$$;

revoke all on function public.team_catalog_creation_preflight(uuid) from public, anon;
grant execute on function public.team_catalog_creation_preflight(uuid) to authenticated;

-- 5. Why a creation's videos have not started -------------------------------------------------

create or replace function public.service_read_initial_catalog_video(p_team uuid, p_actor uuid, p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare result jsonb;descriptor jsonb;s private.catalog_video_sets%rowtype;d private.team_recovery_delegations%rowtype;
begin
 result:=public.service_read_initial_catalog_video_before_foreground(p_team,p_actor,p_key);
 if result->>'outcome'='preparing_video'then
  descriptor:=private.catalog_video_public_executor((result->>'videoSetId')::uuid);if descriptor is not null then result:=result||jsonb_build_object('executor',descriptor);end if;
  if result->>'state' in('preparing','unknown') and exists(select 1 from private.catalog_video_variants v join private.catalog_video_sets s on s.id=v.video_set_id
   join public.team_operations o on o.team_id=s.team_id and o.actor_id=s.actor_id and o.kind='process' and o.idempotency_key='catalog-variant:'||v.request_id::text
   where v.video_set_id=(result->>'videoSetId')::uuid and v.state='working' and o.state in('pending','running')
   and private.catalog_video_variant_last_life(v.video_set_id,v.video_variant_index,o.id)<=clock_timestamp()-interval '2 minutes') then
   result:=result||jsonb_build_object('agentSilent',true);
  end if;
  -- 072: a set handed to background work that nobody has taken says why, as the manager's
  -- registry does for update rounds (private.catalog_registry_video_generation).
  if result->>'state'='preparing' then
   select * into s from private.catalog_video_sets where id=(result->>'videoSetId')::uuid and team_id=p_team;
   if s.id is not null and s.state='accepted' and s.native_instance_id is null and s.executor_id is not null
      and s.created_at<statement_timestamp()-interval '3 minutes' then
    if not exists(select 1 from public.team_materials m join public.team_drive_connections c on c.id=m.connection_id and c.team_id=m.team_id
                  where m.id=s.source_material_id and m.team_id=p_team and c.state in('connected','unavailable')) then
     result:=result||jsonb_build_object('waitReason','NEEDS_REAUTH');
    else
     select * into d from private.team_recovery_delegations where team_id=p_team and actor_id=s.actor_id and installation_id=s.executor_id
      and revoked_at is null and expires_at>statement_timestamp() order by created_at desc limit 1;
     if d.id is null then result:=result||jsonb_build_object('waitReason','AGENT_REQUIRED');
     elsif (d.last_claim_at is null or d.last_claim_at<s.created_at)
      and not exists(select 1 from private.catalog_video_sets o where o.team_id=p_team and o.executor_id=s.executor_id and o.id<>s.id and o.state='preparing') then
      result:=result||jsonb_build_object('backgroundStalled',true);
     end if;
    end if;
   end if;
  end if;
 end if;
 return result;
end $function$;
