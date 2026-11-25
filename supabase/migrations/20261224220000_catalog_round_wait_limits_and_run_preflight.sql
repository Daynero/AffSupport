-- 072 (catalog never hangs silently), server package П2: refuse what cannot run, bound what waits.
--
-- Production, 14 days to 2026-11-25: 24 manager rounds waited for a computer before acceptance
-- (AGENT_REQUIRED) until someone cancelled them by hand; 22 scheduled rounds waited ~370 hours;
-- a manual run in a space paused by its tariff answered «немає дозволу». note_catalog_variant_
-- round_wait moved the item a minute ahead on every pass, so no «idle for six hours» sweep ever
-- saw such a round, and the manager said «Чекає на комп'ютерний агент…» without an end.
--
-- Now:
-- 1. A run, a retry or a run command (run_team_catalog_update_now, retry_team_catalog_update,
--    request_team_catalog_update_command) is refused before anything opens when it cannot run:
--    SPACE_BLOCKED for a paused space (before the permission check, which a paused space fails
--    for everyone), NEEDS_REAUTH / ROOT_MISSING / DRIVE_UNAVAILABLE / CONNECTION_DETACHED for a
--    catalog whose Drive connection is not usable, AGENT_REQUIRED for a re-stitching catalog when the person has no
--    live background work in this space. All but CONNECTION_DETACHED (a folder the space replaced,
--    20261224230000) are codes every released web knows.
-- 2. note_catalog_variant_round_wait (body of 20261207175000) ends a round at once for a code
--    that will not pass by itself (PERMISSION_DENIED — SPACE_BLOCKED in a paused space —,
--    SOURCE_CHANGED, RESTITCH_INVALID, NEEDS_REAUTH, ROOT_MISSING, AGENT_UPDATE_REQUIRED). A round
--    waiting for a computer (AGENT_REQUIRED, AGENT_ID_CONFLICT) is asked again after a growing
--    pause (1 → 15 minutes) and ends with its code after 2 hours; an uncertain result after 30
--    minutes.
-- 3. Every five minutes (settle_catalog_round_limits, 20261224200000) also: a round whose sets
--    no computer has taken up for 6 hours ends AGENT_REQUIRED (no live background work) or
--    AGENT_STALLED (background work exists and never ran it); a round whose computer reported its
--    background work stopped (agent_block_code, 20261224190000) for an hour ends with that code.
--
-- Nothing raises 40001. No new table or column.
-- Rollback: restore note_catalog_variant_round_wait from 20261207175000 and
-- settle_catalog_round_limits from 20261224200000; re-run the three run functions' bodies from
-- 20261207137000, 20261203110000 and 20261207138000 (or remove the one preflight line each);
-- drop private.catalog_run_preflight.

-- 1. What a run would meet, refused where it was pressed. ----------------------------------------
-- With no catalogs, the space only.
create function private.catalog_run_preflight(p_team uuid,p_catalogs uuid[])
returns void language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid();drive text;
begin
 -- Not signed in, or not a member: the caller's own permission check answers as before.
 if actor is null or p_team is null or not exists(select 1 from public.team_members m
   where m.team_id=p_team and m.user_id=actor and m.removed_at is null) then return;end if;
 if not private.team_workspace_allowed(p_team) then raise exception 'SPACE_BLOCKED' using errcode='42501';end if;
 if not private.can(p_team,'process',actor) or p_catalogs is null then return;end if;
 select c.state into drive from unnest(p_catalogs) wanted(id)
  join public.team_materials sheet on sheet.id=wanted.id and sheet.team_id=p_team
  join public.team_drive_connections c on c.id=sheet.connection_id and c.team_id=sheet.team_id
  where c.state not in('connected','unavailable')
  order by c.state limit 1;
 if drive='root_missing' then raise exception 'ROOT_MISSING' using errcode='22023';
 elsif drive='pending' then raise exception 'DRIVE_UNAVAILABLE' using errcode='22023';
 -- A folder the space no longer uses (20261224230000): no re-authorisation reaches it.
 elsif drive='detached' then raise exception 'CONNECTION_DETACHED' using errcode='22023';
 elsif drive is not null then raise exception 'NEEDS_REAUTH' using errcode='22023';
 end if;
 -- The same rule as freeze_catalog_round_variant_profile: this run would re-stitch videos.
 if private.recovery_executor_for(p_team,actor) is null and exists(
   select 1 from unnest(p_catalogs) wanted(id)
   join public.team_catalog_update_profiles p on p.catalog_material_id=wanted.id and p.team_id=p_team
   where p.restitch and (p.video_variant_count>1 or exists(select 1 from private.catalog_video_publication_policies policy
     where policy.catalog_material_id=wanted.id and policy.team_id=p_team))) then
  raise exception 'AGENT_REQUIRED' using errcode='55000';
 end if;
end $$;
revoke all on function private.catalog_run_preflight(uuid,uuid[]) from public,anon,authenticated,service_role;

do $patch$
declare d text;
begin
 select pg_get_functiondef('public.run_team_catalog_update_now(uuid,uuid[])'::regprocedure) into d;
 if strpos(d,$find$begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then$find$)=0 then raise exception 'CATALOG_RUN_PREFLIGHT_PATCH_MISSING';end if;
 d:=replace(d,$find$begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then$find$,$replace$begin
  perform private.catalog_run_preflight(p_team, p_catalogs);
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then$replace$);
 execute d;

 select pg_get_functiondef('public.retry_team_catalog_update(uuid,uuid,uuid)'::regprocedure) into d;
 if strpos(d,$find$begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then$find$)=0 then raise exception 'CATALOG_RETRY_PREFLIGHT_PATCH_MISSING';end if;
 d:=replace(d,$find$begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then$find$,$replace$begin
  -- The space only: the run it calls asks the rest.
  perform private.catalog_run_preflight(p_team, null);
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then$replace$);
 execute d;

 select pg_get_functiondef('public.request_team_catalog_update_command(uuid,uuid,uuid[],uuid,uuid)'::regprocedure) into d;
 if strpos(d,$find$begin
  if actor is null or p_expected_actor is distinct from actor or not private.can(p_team,'process',actor) then$find$)=0 then raise exception 'CATALOG_COMMAND_PREFLIGHT_PATCH_MISSING';end if;
 d:=replace(d,$find$begin
  if actor is null or p_expected_actor is distinct from actor or not private.can(p_team,'process',actor) then$find$,$replace$begin
  -- 072: the space only; the run it calls asks the rest after a replay has been answered.
  perform private.catalog_run_preflight(p_team,null);
  if actor is null or p_expected_actor is distinct from actor or not private.can(p_team,'process',actor) then$replace$);
 execute d;
end $patch$;

-- 2. A waiting round ends, or waits with a growing pause and a limit. ---------------------------
create or replace function private.note_catalog_variant_round_wait(p_attempt uuid,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_variant_round_snapshots%rowtype;a public.team_catalog_update_attempts%rowtype;code text:=p_code;kind text;age interval;pause interval;
begin
 if p_code is null or p_code not in('AGENT_REQUIRED','AGENT_ID_CONFLICT','PERMISSION_DENIED','SOURCE_CHANGED','RESTITCH_INVALID','PROCESS_RESULT_UNCERTAIN',
   'SPACE_BLOCKED','NEEDS_REAUTH','ROOT_MISSING','AGENT_UPDATE_REQUIRED','DRIVE_UNAVAILABLE','RATE_LIMITED')
 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 select * into r from private.catalog_variant_round_snapshots where attempt_id=p_attempt;
 select * into a from public.team_catalog_update_attempts where attempt_id=p_attempt;
 -- A space paused by its tariff refuses everyone's permission; say which it is.
 if code='PERMISSION_DENIED' and r.team_id is not null and not private.team_workspace_allowed(r.team_id) then code:='SPACE_BLOCKED';end if;
 kind:=private.catalog_round_failure_kind(code);
 age:=clock_timestamp()-coalesce(a.started_at,clock_timestamp());
 if a.result='running' and (kind='final' or (kind='agent' and age>=interval '2 hours') or (kind='passing' and age>=interval '30 minutes')) then
  return private.close_catalog_variant_round(p_attempt,code);
 end if;
 pause:=least(interval '15 minutes',greatest(interval '1 minute',age/4));
 update private.catalog_variant_round_snapshots set failure_code=code where attempt_id=p_attempt returning * into r;
 update public.team_catalog_update_attempts set failure_code=code where attempt_id=p_attempt and result='running';
 update public.team_catalog_updater_items set next_attempt_at=clock_timestamp()+pause
  where catalog_material_id=r.catalog_material_id and team_id=r.team_id and round_due_at=a.round_due_at;
 insert into public.team_catalog_events(team_id,material_id,event_kind)values(r.team_id,r.catalog_material_id,'sync_state');
 return jsonb_build_object('outcome','blocked','failureCode',code,'requestId',p_attempt);
end;$$;

-- 3. The five-minute sweep also ends rounds no computer takes up. -------------------------------
create or replace function private.settle_catalog_round_limits(p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r record;orphans integer:=0;unreachable integer:=0;unclaimed integer:=0;code text;
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'INVALID_INPUT' using errcode='22023';end if;

 -- (1) The catalog left the manager or the space while its round still had a request.
 for r in
  select req.request_id,req.team_id,req.catalog_material_id
  from private.catalog_updater_variant_requests req
  join public.team_catalog_update_attempts a on a.attempt_id=req.attempt_id and a.team_id=req.team_id and a.result='running'
  where req.canceled_at is null and req.publication_receipt is null
    and a.started_at<clock_timestamp()-interval '15 minutes'
    and (not exists(select 1 from public.team_materials m where m.id=req.catalog_material_id and m.team_id=req.team_id and m.lifecycle='active')
      or not exists(select 1 from public.team_catalog_updater_items i where i.catalog_material_id=req.catalog_material_id and i.team_id=req.team_id and i.round_due_at=a.round_due_at))
    and not private.settle_row_deferred('catalog_round_orphan_request',req.request_id)
  order by a.started_at limit p_limit
 loop
  begin
   perform private.cancel_catalog_updater_variant_round(r.team_id,r.catalog_material_id,r.request_id);
   perform private.clear_settle_row_failure('catalog_round_orphan_request',r.request_id);
   orphans:=orphans+1;
  exception when others then
   perform private.note_settle_row_failure('catalog_round_orphan_request',r.request_id,sqlstate,sqlerrm);
  end;
 end loop;

 -- (2) The catalog's Drive connection is no longer usable (close_unreachable_catalog_rounds skips
 --     a round held by a variant request's lease).
 for r in
  select req.request_id,req.attempt_id,c.state
  from private.catalog_updater_variant_requests req
  join public.team_catalog_update_attempts a on a.attempt_id=req.attempt_id and a.team_id=req.team_id and a.result='running'
  join public.team_materials sheet on sheet.id=req.catalog_material_id and sheet.team_id=req.team_id
  join public.team_drive_connections c on c.id=sheet.connection_id and c.team_id=sheet.team_id
  where req.canceled_at is null and req.publication_receipt is null
    and c.state not in('connected','unavailable')
    and not exists(select 1 from private.catalog_video_variants live
      where live.video_set_id in(select x.set_id from private.catalog_round_sets(req.set_id) x)
        and coalesce(live.heartbeat_at,'-infinity'::timestamptz)>clock_timestamp()-interval '15 minutes')
    and not private.settle_row_deferred('catalog_round_unreachable_request',req.request_id)
  order by a.started_at limit p_limit
 loop
  begin
   perform private.close_catalog_variant_round(r.attempt_id,case r.state when 'root_missing' then 'ROOT_MISSING' when 'pending' then 'DRIVE_UNAVAILABLE' when 'detached' then 'CONNECTION_DETACHED' else 'NEEDS_REAUTH' end);
   perform private.clear_settle_row_failure('catalog_round_unreachable_request',r.request_id);
   unreachable:=unreachable+1;
  exception when others then
   perform private.note_settle_row_failure('catalog_round_unreachable_request',r.request_id,sqlstate,sqlerrm);
  end;
 end loop;

 -- (3) Sets no computer has taken up: none of the round's sets started (no native instance, not
 --     preparing), nothing beat for 15 minutes, and either six hours passed since the set was
 --     accepted, or the computer reported its background work stopped an hour ago or more.
 --     A computer busy with another set of this person's keeps its queue.
 for r in
  select req.request_id,req.attempt_id,s.team_id,s.actor_id,s.executor_id,s.created_at,
   d.id delegation_id,d.agent_block_code,d.agent_block_at
  from private.catalog_updater_variant_requests req
  join public.team_catalog_update_attempts a on a.attempt_id=req.attempt_id and a.team_id=req.team_id and a.result='running'
  join private.catalog_video_sets s on s.id=req.set_id and s.team_id=req.team_id
  left join lateral(select x.id,x.agent_block_code,x.agent_block_at from private.team_recovery_delegations x
    where x.team_id=s.team_id and x.actor_id=s.actor_id and x.installation_id=s.executor_id
      and x.revoked_at is null and x.expires_at>clock_timestamp()
    order by x.created_at desc limit 1) d on true
  where req.canceled_at is null and req.publication_receipt is null
    and private.catalog_round_state(req.set_id)='accepted'
    and not exists(select 1 from private.catalog_round_sets(req.set_id) x join private.catalog_video_sets o on o.id=x.set_id
      where o.native_instance_id is not null or o.state<>'accepted')
    and not exists(select 1 from private.catalog_video_variants live
      where live.video_set_id in(select x.set_id from private.catalog_round_sets(req.set_id) x)
        and (live.state in('working','unknown') or coalesce(live.heartbeat_at,'-infinity'::timestamptz)>clock_timestamp()-interval '15 minutes'))
    and (s.created_at<clock_timestamp()-interval '6 hours'
      or (d.agent_block_code is not null and d.agent_block_at<clock_timestamp()-interval '1 hour' and s.created_at<clock_timestamp()-interval '1 hour'))
    and not exists(select 1 from private.catalog_video_sets busy where busy.team_id=s.team_id and busy.executor_id=s.executor_id
      and busy.id<>s.id and busy.state='preparing' and busy.updated_at>clock_timestamp()-interval '6 hours')
    and not private.settle_row_deferred('catalog_round_unclaimed',req.request_id)
  order by s.created_at limit p_limit
 loop
  begin
   code:=case
    when r.delegation_id is null then 'AGENT_REQUIRED'
    when r.agent_block_code ~ '^[A-Z_]{2,64}$' then r.agent_block_code
    else 'AGENT_STALLED' end;
   perform private.close_catalog_variant_round(r.attempt_id,code);
   perform private.clear_settle_row_failure('catalog_round_unclaimed',r.request_id);
   unclaimed:=unclaimed+1;
  exception when others then
   perform private.note_settle_row_failure('catalog_round_unclaimed',r.request_id,sqlstate,sqlerrm);
  end;
 end loop;

 return jsonb_build_object('orphans',orphans,'unreachable',unreachable,'unclaimed',unclaimed);
end $$;
revoke all on function private.settle_catalog_round_limits(integer) from public,anon,authenticated,service_role;
