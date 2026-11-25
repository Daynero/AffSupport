-- 072 (catalog never hangs silently), server package П1: a round ends or waits with a limit.
--
-- Production 2026-11-25: any failure of a catalog manager round between its acceptance and its
-- video set (RESTITCH_INVALID, PERMISSION_DENIED, SOURCE_CHANGED, SHARE_NOT_ALLOWED,
-- RESTITCH_POOL_EMPTY, NEEDS_REAUTH, DRIVE_UNAVAILABLE, …) was written only to
-- catalog_updater_variant_requests.failure_code. The request stayed admitted with the item's lease
-- until 'infinity', drive-ops listed it again every minute, no sweep closed it (each skips a round
-- with a live request) and the web, which reads the snapshot and the attempt, said «Готуємо
-- відео…». Three such rounds held two of the three slots of the service-wide listing.
--
-- Now:
-- 1. drive-ops hands the failure to service_fail_catalog_updater_variant_admission. A code that
--    does not pass by itself ends the round at once (attempt 'failed' with the code, the
--    catalog's last error, the request cancelled, the item free). A passing one (DRIVE_UNAVAILABLE,
--    RATE_LIMITED, an uncertain result) pauses the request (retry_at, 1 → 10 minutes) and ends the
--    round with its code once it has lasted 30 minutes. NEEDS_REAUTH also marks the Drive
--    connection, as every other Drive caller does.
--    Re-stitch refusals (RESTITCH_INVALID, _POOL_EMPTY, _NO_SCREENS, _SOURCES_INVALID) on settings
--    frozen before Soty's standard pictures (20261224170000) are tried once more with today's
--    effective settings; only settings that still refuse end the round.
-- 2. The same for a ready set whose links cannot be attached (service_fail_catalog_updater_
--    variant_target): a lasting failure ends the round after 2 hours instead of retrying for ever.
-- 3. The listings skip a paused request and serve the oldest due work first, so failing rounds
--    can no longer starve every space's re-stitching (the 2026-11-22 R2 sweep incident shape).
-- 4. The manager row reads a waiting request's code (only reasons every released web knows; the
--    raw code goes in `waitCode`), and a computer that reported its background work stopped
--    (20261224190000, `agent_block_code`) reads as stalled with that code.
-- 5. Every five minutes: a round whose catalog left the manager or the space (trash, missing),
--    or whose Drive connection is no longer usable, is ended (cancelled, or failed with
--    NEEDS_REAUTH / ROOT_MISSING / DRIVE_UNAVAILABLE / CONNECTION_DETACHED as
--    close_unreachable_catalog_rounds does).
--
-- Nothing raises a retryable class: refusals keep the existing 42501/22023/55000 codes, never
-- 40001. No new table; two timestamp columns, no jsonb, no foreign key.
-- Rollback: unschedule 'soty-catalog-round-limits', drop the three new functions and the two
-- service functions, restore the listings, the note and the registry from 20261207175000,
-- 20261207172000 and 20261207390000; the columns and the wider checks may stay.

alter table private.catalog_updater_variant_requests
 add column retry_at timestamptz,
 add column first_error_at timestamptz;
comment on column private.catalog_updater_variant_requests.retry_at is
 '072: a passing failure pauses the request until then; listings skip it before.';
comment on column private.catalog_updater_variant_requests.first_error_at is
 '072: since when the current phase keeps failing; the round ends once this lasts.';

-- The codes a request and a round may now end or wait with.
alter table private.catalog_updater_variant_requests drop constraint catalog_updater_variant_requests_failure_code_check;
alter table private.catalog_updater_variant_requests add constraint catalog_updater_variant_requests_failure_code_check check (failure_code = any(array[
 'RESTITCH_SCREEN_SELECTION_LIMIT','RESTITCH_FORBIDDEN','RESTITCH_NO_SCREENS','RESTITCH_INVALID','RESTITCH_POOL_EMPTY',
 'RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID','RESTITCH_SOURCES_TOO_MANY','RESTITCH_CLIENT_OUTDATED',
 'RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_PREVIOUS_FAILURES','RESTITCH_SCREEN_BYTE_LIMIT','RESTITCH_SCREEN_IO_LIMIT',
 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN','SOURCE_CHANGED','PERMISSION_DENIED','DRIVE_UNAVAILABLE','RATE_LIMITED',
 'PROCESS_RESULT_UNCERTAIN','INVALID_RESPONSE','SHARE_NOT_ALLOWED',
 'NEEDS_REAUTH','ROOT_MISSING','DRIVE_STORAGE_FULL','SPACE_BLOCKED','AGENT_REQUIRED','AGENT_ID_CONFLICT',
 'AGENT_UPDATE_REQUIRED','AGENT_STALLED','DISK_FULL','CONNECTION_DETACHED']::text[]));
alter table private.catalog_variant_round_snapshots drop constraint catalog_variant_round_snapshots_failure_code_check;
alter table private.catalog_variant_round_snapshots add constraint catalog_variant_round_snapshots_failure_code_check check (failure_code = any(array[
 'AGENT_REQUIRED','AGENT_ID_CONFLICT','PERMISSION_DENIED','SOURCE_CHANGED','RESTITCH_INVALID','PROCESS_RESULT_UNCERTAIN',
 'SPACE_BLOCKED','NEEDS_REAUTH','ROOT_MISSING','DRIVE_UNAVAILABLE','RATE_LIMITED','AGENT_UPDATE_REQUIRED','AGENT_STALLED','CONNECTION_DETACHED']::text[]));

-- What a failure means for its round: it passes by itself, it waits for a computer, or it ends.
create function private.catalog_round_failure_kind(p_code text)
returns text language sql immutable set search_path='' as $$
 select case
  when p_code in('DRIVE_UNAVAILABLE','RATE_LIMITED','PROCESS_RESULT_UNCERTAIN','INVALID_RESPONSE','RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN') then 'passing'
  when p_code in('AGENT_REQUIRED','AGENT_ID_CONFLICT') then 'agent'
  else 'final' end
$$;
revoke all on function private.catalog_round_failure_kind(text) from public,anon,authenticated,service_role;

-- Ends a running round with a code: the attempt fails, the catalog keeps the code as its last
-- error, a variant request is cancelled (its sets too), the item is free for the next round.
-- A round that already ended is left as it is and answered with its own code.
create function private.close_catalog_variant_round(p_attempt uuid,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.team_catalog_update_attempts%rowtype;r private.catalog_updater_variant_requests%rowtype;
begin
 if p_code is null or p_code !~ '^[A-Z_]{2,64}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 -- Request before attempt, the order cancel_catalog_updater_variant_round takes them in.
 select * into r from private.catalog_updater_variant_requests where attempt_id=p_attempt for update;
 select * into a from public.team_catalog_update_attempts where attempt_id=p_attempt for update;
 if a.attempt_id is null then return null;end if;
 if a.result<>'running' then
  return jsonb_build_object('outcome','blocked','failureCode',coalesce(a.failure_code,p_code),'requestId',p_attempt,'closed',true);
 end if;
 if r.request_id is not null and r.canceled_at is null then
  begin
   update private.catalog_updater_variant_requests set failure_code=p_code,last_error_at=clock_timestamp(),retry_at=null where request_id=r.request_id;
  exception when check_violation then
   update private.catalog_updater_variant_requests set failure_code='PROCESS_RESULT_UNCERTAIN',last_error_at=clock_timestamp(),retry_at=null where request_id=r.request_id;
  end;
  perform private.cancel_catalog_updater_variant_round(r.team_id,r.catalog_material_id,r.request_id);
 end if;
 begin
  update private.catalog_variant_round_snapshots set failure_code=p_code where attempt_id=p_attempt;
 exception when check_violation then null;
 end;
 update public.team_catalog_update_attempts set result='failed',failure_code=p_code,ended_at=coalesce(ended_at,clock_timestamp())
  where attempt_id=p_attempt and result in('running','cancelled');
 update public.team_product_catalogs set last_update_error=p_code,last_update_error_at=clock_timestamp()
  where material_id=a.catalog_material_id and team_id=a.team_id;
 update public.team_catalog_updater_items set round_due_at=null,attempts=0,lease_owner=null,lease_expires_at=null,next_attempt_at=clock_timestamp()
  where catalog_material_id=a.catalog_material_id and team_id=a.team_id and round_due_at=a.round_due_at;
 perform private.sync_catalog_updater(a.team_id);
 insert into public.team_catalog_events(team_id,material_id,event_kind) values(a.team_id,a.catalog_material_id,'sync_state');
 return jsonb_build_object('outcome','blocked','failureCode',p_code,'requestId',p_attempt,'closed',true);
end $$;
revoke all on function private.close_catalog_variant_round(uuid,text) from public,anon,authenticated,service_role;

-- A passing failure: pause the request and the item, or end the round once it has lasted.
create function private.pause_catalog_variant_request(r private.catalog_updater_variant_requests,p_code text,p_limit interval,p_most interval)
returns jsonb language plpgsql security definer set search_path='' as $$
declare since timestamptz;pause interval;
begin
 since:=coalesce(r.first_error_at,clock_timestamp());
 if clock_timestamp()-since>=p_limit then return private.close_catalog_variant_round(r.attempt_id,p_code);end if;
 pause:=least(p_most,greatest(interval '1 minute',(clock_timestamp()-since)/2));
 update private.catalog_updater_variant_requests set failure_code=p_code,last_error_at=clock_timestamp(),first_error_at=since,retry_at=clock_timestamp()+pause
  where request_id=r.request_id;
 update public.team_catalog_updater_items set next_attempt_at=clock_timestamp()+pause
  where catalog_material_id=r.catalog_material_id and team_id=r.team_id and lease_owner='catalog-variants:'||r.request_id::text;
 insert into public.team_catalog_events(team_id,material_id,event_kind) values(r.team_id,r.catalog_material_id,'sync_state');
 return jsonb_build_object('outcome','retry','failureCode',p_code,'requestId',r.request_id,'retryAt',clock_timestamp()+pause);
end $$;
revoke all on function private.pause_catalog_variant_request(private.catalog_updater_variant_requests,text,interval,interval) from public,anon,authenticated,service_role;

-- drive-ops: the admission of an accepted round's sets failed with this code.
create function public.service_fail_catalog_updater_variant_admission(p_team uuid,p_actor uuid,p_request uuid,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;code text;current jsonb;credential uuid;
begin
 select * into r from private.catalog_updater_variant_requests where request_id=p_request and team_id=p_team and actor_id=p_actor for update;
 if r.request_id is null then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if r.canceled_at is not null then
  return jsonb_build_object('outcome','blocked','failureCode',r.failure_code,'requestId',p_request,'closed',true);
 end if;
 code:=case when p_code ~ '^RESTITCH_[A-Z_]{1,55}$' or p_code in('SOURCE_CHANGED','PERMISSION_DENIED','SHARE_NOT_ALLOWED','NEEDS_REAUTH','ROOT_MISSING',
   'DRIVE_STORAGE_FULL','SPACE_BLOCKED','AGENT_REQUIRED','AGENT_UPDATE_REQUIRED','DRIVE_UNAVAILABLE','RATE_LIMITED','INVALID_RESPONSE')
  then p_code else 'PROCESS_RESULT_UNCERTAIN' end;
 -- A space blocked by its tariff reads as such, not as a refused permission.
 if code='PERMISSION_DENIED' and not private.team_workspace_allowed(p_team) then code:='SPACE_BLOCKED';end if;
 -- Settings frozen before Soty's standard pictures: one more try with today's effective ones.
 if code in('RESTITCH_INVALID','RESTITCH_POOL_EMPTY','RESTITCH_NO_SCREENS','RESTITCH_SOURCES_INVALID')
  and not exists(select 1 from private.catalog_video_sets s where s.update_attempt_id=r.attempt_id) then
  current:=private.effective_restitch_defaults_json(p_team,p_actor);
  if current->>'configured'='true' and current is distinct from r.settings_snapshot then
   update private.catalog_updater_variant_requests set settings_snapshot=current,failure_code=null,last_error_at=null,retry_at=null
    where request_id=p_request;
   update private.catalog_variant_round_snapshots set settings_snapshot=current,failure_code=null where attempt_id=r.attempt_id;
   return jsonb_build_object('outcome','retry','failureCode',code,'requestId',p_request,'retryAt',clock_timestamp());
  end if;
 end if;
 if private.catalog_round_failure_kind(code)='passing' then
  return private.pause_catalog_variant_request(r,code,interval '30 minutes',interval '10 minutes');
 end if;
 if code='NEEDS_REAUTH' then
  begin credential:=(r.provider_context->>'credentialId')::uuid;exception when others then credential:=null;end;
  if credential is not null then perform public.service_mark_drive_needs_reauth(credential);end if;
 end if;
 return private.close_catalog_variant_round(r.attempt_id,code);
end $$;
revoke all on function public.service_fail_catalog_updater_variant_admission(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_fail_catalog_updater_variant_admission(uuid,uuid,uuid,text) to service_role;

-- drive-ops: the round's ready set could not be attached to its publication target.
create function public.service_fail_catalog_updater_variant_target(p_team uuid,p_actor uuid,p_request uuid,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;code text;credential uuid;
begin
 select * into r from private.catalog_updater_variant_requests where request_id=p_request and team_id=p_team and actor_id=p_actor for update;
 if r.request_id is null then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if r.canceled_at is not null or r.publication_receipt is not null then
  return jsonb_build_object('outcome','blocked','failureCode',r.failure_code,'requestId',p_request,'closed',r.canceled_at is not null);
 end if;
 code:=case when p_code in('SOURCE_CHANGED','PERMISSION_DENIED','SHARE_NOT_ALLOWED','NEEDS_REAUTH','ROOT_MISSING','SPACE_BLOCKED',
   'DRIVE_UNAVAILABLE','RATE_LIMITED','INVALID_RESPONSE') then p_code else 'PROCESS_RESULT_UNCERTAIN' end;
 if code='PERMISSION_DENIED' and not private.team_workspace_allowed(p_team) then code:='SPACE_BLOCKED';end if;
 if private.catalog_round_failure_kind(code)='passing' then
  return private.pause_catalog_variant_request(r,code,interval '2 hours',interval '30 minutes');
 end if;
 if code='NEEDS_REAUTH' then
  begin credential:=(r.provider_context->>'credentialId')::uuid;exception when others then credential:=null;end;
  if credential is not null then perform public.service_mark_drive_needs_reauth(credential);end if;
 end if;
 return private.close_catalog_variant_round(r.attempt_id,code);
end $$;
revoke all on function public.service_fail_catalog_updater_variant_target(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_fail_catalog_updater_variant_target(uuid,uuid,uuid,text) to service_role;

-- The diagnostic note (body of 20261207172000): the sets' admission passing starts the next
-- phase's failure clock afresh. A source proven halfway through does not: a round that proves its
-- first video and fails on the second must still reach its limit.
create or replace function public.service_note_catalog_updater_variant_admission(p_team uuid,p_actor uuid,p_request uuid,p_stage text,p_code text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 if private.can(p_team,'view',p_actor)is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_stage not in('admitted','source_proven','set_admitted')or(p_code is not null and p_code not in('RESTITCH_SCREEN_SELECTION_LIMIT','RESTITCH_FORBIDDEN','RESTITCH_NO_SCREENS','RESTITCH_INVALID','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID','RESTITCH_SOURCES_TOO_MANY','RESTITCH_CLIENT_OUTDATED','RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_PREVIOUS_FAILURES','RESTITCH_SCREEN_BYTE_LIMIT','RESTITCH_SCREEN_IO_LIMIT','RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN','SOURCE_CHANGED','PERMISSION_DENIED','RESTITCH_INVALID','DRIVE_UNAVAILABLE','RATE_LIMITED','PROCESS_RESULT_UNCERTAIN','INVALID_RESPONSE','SHARE_NOT_ALLOWED'))then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 update private.catalog_updater_variant_requests set last_proven_stage=case when last_proven_stage='set_admitted'or p_stage='set_admitted'then 'set_admitted'when last_proven_stage='source_proven'or p_stage='source_proven'then 'source_proven'else 'admitted'end,failure_code=p_code,last_error_at=case when p_code is not null then clock_timestamp()else null end,
  first_error_at=case when p_stage='set_admitted' and p_code is null then null else first_error_at end,
  retry_at=case when p_stage='set_admitted' and p_code is null then null else retry_at end
  where team_id=p_team and actor_id=p_actor and request_id=p_request and canceled_at is null;
end;$$;

-- The worker's listing of rounds to adopt or admit (body of 20261207175000): a paused request is
-- skipped, and the oldest due work comes first, so failing rounds cannot hold every slot.
create or replace function public.service_list_catalog_variant_rounds(p_limit integer default 3)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_limit is null or p_limit not between 1 and 3 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('teamId',x.team_id,'actorId',x.actor_id,'catalogMaterialId',x.catalog_material_id,'attemptId',x.request_id) order by x.due,x.created_at,x.request_id)from(
 select s.team_id,s.actor_id,s.catalog_material_id,s.attempt_id request_id,s.created_at,i.next_attempt_at due from private.catalog_variant_round_snapshots s join public.team_catalog_update_attempts a on a.attempt_id=s.attempt_id and a.team_id=s.team_id join public.team_catalog_updater_items i on i.catalog_material_id=s.catalog_material_id and i.team_id=s.team_id and i.round_due_at=a.round_due_at where a.result='running'and i.next_attempt_at<=clock_timestamp()and(i.lease_expires_at is null or i.lease_expires_at<=clock_timestamp())and not i.reconciliation_required and not exists(select 1 from private.catalog_update_reconciliations q where q.catalog_material_id=s.catalog_material_id)and not exists(select 1 from private.catalog_updater_variant_requests r where r.attempt_id=s.attempt_id)
 union all select r.team_id,r.actor_id,r.catalog_material_id,r.request_id,r.created_at,greatest(i.next_attempt_at,coalesce(r.retry_at,'-infinity'::timestamptz)) from private.catalog_updater_variant_requests r join public.team_catalog_update_attempts a on a.attempt_id=r.attempt_id join public.team_catalog_updater_items i on i.catalog_material_id=r.catalog_material_id and i.team_id=r.team_id and i.round_due_at=a.round_due_at where a.result='running'and r.canceled_at is null and exists(select 1 from private.catalog_round_sets(r.set_id) x where not exists(select 1 from private.catalog_video_sets s where s.id=x.set_id))and i.next_attempt_at<=clock_timestamp()and(r.retry_at is null or r.retry_at<=clock_timestamp())and i.lease_owner='catalog-variants:'||r.request_id::text and not i.reconciliation_required
 order by due,created_at,request_id limit p_limit)x),'[]'::jsonb);
end;$$;

-- The ready-set listing (body of 20261207172000): the same pause and the same order.
create or replace function public.service_list_catalog_updater_variant_targets(p_limit integer default 3)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_limit is null or p_limit not between 1 and 3 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('teamId',r.team_id,'actorId',r.actor_id,'catalogMaterialId',r.catalog_material_id,'requestId',r.request_id) order by r.due,r.request_id)from(select q.*,coalesce(q.retry_at,q.created_at) due from private.catalog_updater_variant_requests q join private.catalog_video_sets s on s.id=q.set_id and s.team_id=q.team_id where q.canceled_at is null and q.publication_receipt is null and(q.retry_at is null or q.retry_at<=clock_timestamp())and s.state='ready'and private.catalog_round_state(q.set_id)='ready'and private.can(q.team_id,'view',q.actor_id)and private.can(q.team_id,'process',q.actor_id)and private.can(q.team_id,'upload',q.actor_id)order by coalesce(q.retry_at,q.created_at),q.request_id limit p_limit)r),'[]'::jsonb);
end;$$;

-- The manager row (body of 20261207390000): a waiting request says why, and a computer that
-- reported its background work stopped reads as stalled with that code. `waitReason` keeps to
-- the reasons every released web parses; the raw code is `waitCode`.
do $patch$
declare d text;
begin
 select pg_get_functiondef('private.catalog_registry_video_generation(uuid,uuid)'::regprocedure) into d;
 if strpos(d,$find$stalled boolean:=false;$find$)=0
  or strpos(d,$find$ -- An update round's set that nobody has claimed: is there background work to claim it?$find$)=0
  or strpos(d,$find$elsif (d.last_claim_at is null or d.last_claim_at<s.created_at)$find$)=0
  or strpos(d,$find$'waitReason',reason,$find$)=0
 then raise exception 'CATALOG_REGISTRY_WAIT_PATCH_MISSING';end if;
 d:=replace(d,$find$stalled boolean:=false;$find$,$replace$stalled boolean:=false;wait_code text;$replace$);
 d:=replace(d,$find$ -- An update round's set that nobody has claimed: is there background work to claim it?$find$,
  $replace$ -- 072: a request pausing after a failure says why.
 if st<>'ready' and reason is null then
  select v.failure_code into wait_code from private.catalog_updater_variant_requests v join public.team_catalog_update_attempts a on a.attempt_id=v.attempt_id
   where v.team_id=p_team and v.catalog_material_id=p_catalog and v.set_id=sid and v.canceled_at is null and a.result in('running','unknown') limit 1;
  if wait_code is not null then
   reason:=case when wait_code in('AGENT_REQUIRED','AGENT_ID_CONFLICT','PERMISSION_DENIED','SOURCE_CHANGED','RESTITCH_INVALID') then wait_code else 'PROCESS_RESULT_UNCERTAIN' end;
  end if;
 end if;
 -- An update round's set that nobody has claimed: is there background work to claim it?$replace$);
 d:=replace(d,$find$elsif (d.last_claim_at is null or d.last_claim_at<s.created_at)$find$,
  $replace$elsif d.agent_block_code is not null then
    -- 072 (20261224190000): the computer said its background work stopped, and why.
    stalled:=true;wait_code:=d.agent_block_code;
    if d.agent_block_code='AGENT_REQUIRED' then reason:='AGENT_REQUIRED';end if;
   elsif (d.last_claim_at is null or d.last_claim_at<s.created_at)$replace$);
 d:=replace(d,$find$'waitReason',reason,$find$,$replace$'waitReason',reason,'waitCode',wait_code,$replace$);
 execute d;
end $patch$;

-- Every five minutes: rounds nothing can finish any more.
create function private.settle_catalog_round_limits(p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r record;orphans integer:=0;unreachable integer:=0;
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

 return jsonb_build_object('orphans',orphans,'unreachable',unreachable);
end $$;
revoke all on function private.settle_catalog_round_limits(integer) from public,anon,authenticated,service_role;

select cron.schedule('soty-catalog-round-limits','*/5 * * * *',$cron$select private.settle_catalog_round_limits()$cron$);
