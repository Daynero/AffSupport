-- Production 2026-11-25: a catalog update with video re-stitching in a space whose re-stitch
-- settings were never saved read «Готуємо відео для заміни…» / «Готово відео: 0 з 1» for ever.
-- The round froze an empty settings snapshot ('{}'), adoption copied it into the variant request
-- without looking, and drive-ops refused it as RESTITCH_INVALID on every pass while the request
-- stayed admitted and uncancelled. The manual path (service_accept_catalog_updater_variants)
-- already refused unconfigured settings; only the manager/updater round path had the hole.
--
-- Now:
-- 1. A round opened without configured settings is marked RESTITCH_INVALID at once (snapshot and
--    attempt), so the manager row can say why instead of «preparing».
-- 2. Adoption re-reads the person's settings when the frozen ones are not configured: saved since
--    the round opened, the round goes on with them; still missing, the round ends — attempt
--    'failed' with RESTITCH_INVALID, the catalog's last error RESTITCH_INVALID, the item released.
--    No variant request is created.
-- 3. A variant request already admitted with unconfigured settings and no video set yet (the
--    rounds left behind before this fix) is settled the same way on its next resume.
-- 4. A request-less round that failed reads as 'canceled' (with its failure code), not 'accepted'.
--
-- Nothing raises: the refusal is the existing 'blocked' answer, so no PostgREST retry loop. No new
-- table or column.

create function private.close_catalog_round_without_restitch_settings(p_attempt uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare n private.catalog_variant_round_snapshots%rowtype;a public.team_catalog_update_attempts%rowtype;
begin
 update private.catalog_variant_round_snapshots set failure_code='RESTITCH_INVALID' where attempt_id=p_attempt returning * into n;
 update public.team_catalog_update_attempts set result='failed',failure_code='RESTITCH_INVALID',ended_at=coalesce(ended_at,clock_timestamp())
  where attempt_id=p_attempt and result in('running','cancelled') returning * into a;
 if a.attempt_id is not null then
  update public.team_product_catalogs set last_update_error='RESTITCH_INVALID',last_update_error_at=clock_timestamp()
   where material_id=a.catalog_material_id and team_id=a.team_id;
  update public.team_catalog_updater_items set round_due_at=null,attempts=0,lease_owner=null,lease_expires_at=null,next_attempt_at=clock_timestamp()
   where catalog_material_id=a.catalog_material_id and team_id=a.team_id and round_due_at=a.round_due_at;
  perform private.sync_catalog_updater(a.team_id);
  insert into public.team_catalog_events(team_id,material_id,event_kind) values(a.team_id,a.catalog_material_id,'sync_state');
 end if;
 return jsonb_build_object('outcome','blocked','failureCode','RESTITCH_INVALID','requestId',p_attempt);
end $$;
revoke all on function private.close_catalog_round_without_restitch_settings(uuid) from public,anon,authenticated,service_role;

-- An admitted request whose settings were never configured and whose videos never started.
create function private.settle_unconfigured_catalog_variant_request(r private.catalog_updater_variant_requests)
returns jsonb language plpgsql security definer set search_path='' as $$
declare current jsonb;
begin
 current:=private.effective_restitch_defaults_json(r.team_id,r.actor_id);
 if current->>'configured'='true' then
  update private.catalog_updater_variant_requests set settings_snapshot=current,failure_code=null,last_error_at=null
   where request_id=r.request_id returning * into r;
  update private.catalog_variant_round_snapshots set settings_snapshot=current,failure_code=null where attempt_id=r.attempt_id;
  update public.team_catalog_update_attempts set failure_code=null where attempt_id=r.attempt_id and result='running';
  return private.catalog_updater_variant_request_json(r);
 end if;
 update private.catalog_updater_variant_requests set failure_code='RESTITCH_INVALID',last_error_at=clock_timestamp() where request_id=r.request_id;
 perform private.cancel_catalog_updater_variant_round(r.team_id,r.catalog_material_id,r.request_id);
 return private.close_catalog_round_without_restitch_settings(r.attempt_id);
end $$;
revoke all on function private.settle_unconfigured_catalog_variant_request(private.catalog_updater_variant_requests) from public,anon,authenticated,service_role;

do $patch$
declare d text;
begin
 -- 1. The round says at once that it has no settings to work with.
 select pg_get_functiondef('private.capture_catalog_round_video_snapshot()'::regprocedure) into d;
 if strpos(d,$find$then 'manager'else 'updater'end);$find$)=0 then raise exception 'RESTITCH_SETTINGS_CAPTURE_PATCH_MISSING';end if;
 d:=replace(d,$find$then 'manager'else 'updater'end);$find$,
  $replace$then 'manager'else 'updater'end);
 if (select s.settings_snapshot->>'configured' from private.catalog_variant_round_snapshots s where s.attempt_id=new.attempt_id) is distinct from 'true' then
  update private.catalog_variant_round_snapshots set failure_code='RESTITCH_INVALID' where attempt_id=new.attempt_id;
  update public.team_catalog_update_attempts set failure_code='RESTITCH_INVALID' where attempt_id=new.attempt_id and result='running';
 end if;$replace$);
 execute d;

 -- 2. Adoption never copies unconfigured settings into a request.
 select pg_get_functiondef('public.service_adopt_catalog_variant_round(uuid,uuid,uuid,uuid,uuid)'::regprocedure) into d;
 if strpos(d,$find$ if not private.team_workspace_allowed(p_team)then return private.note_catalog_variant_round_wait(p_attempt,'PERMISSION_DENIED');end if;$find$)=0
 then raise exception 'RESTITCH_SETTINGS_ADOPT_PATCH_MISSING';end if;
 d:=replace(d,$find$ if not private.team_workspace_allowed(p_team)then return private.note_catalog_variant_round_wait(p_attempt,'PERMISSION_DENIED');end if;$find$,
  $replace$ if not private.team_workspace_allowed(p_team)then return private.note_catalog_variant_round_wait(p_attempt,'PERMISSION_DENIED');end if;
 if snap.settings_snapshot->>'configured' is distinct from 'true' then
  ctx:=private.effective_restitch_defaults_json(p_team,p_actor);
  if ctx->>'configured' is distinct from 'true' then return private.close_catalog_round_without_restitch_settings(p_attempt);end if;
  update private.catalog_variant_round_snapshots set settings_snapshot=ctx,failure_code=null where attempt_id=p_attempt returning * into snap;
 end if;$replace$);
 execute d;

 -- 3. Requests admitted before this fix with nothing to work with are settled on resume.
 select pg_get_functiondef('public.service_resume_catalog_updater_variants(uuid,uuid,uuid,uuid)'::regprocedure) into d;
 if strpos(d,$find$ if r.request_id is null then return public.service_adopt_catalog_variant_round(p_team,p_actor,p_catalog,p_request);end if;$find$)=0
 then raise exception 'RESTITCH_SETTINGS_RESUME_PATCH_MISSING';end if;
 d:=replace(d,$find$ if r.request_id is null then return public.service_adopt_catalog_variant_round(p_team,p_actor,p_catalog,p_request);end if;$find$,
  $replace$ if r.request_id is null then return public.service_adopt_catalog_variant_round(p_team,p_actor,p_catalog,p_request);end if;
 if r.settings_snapshot->>'configured' is distinct from 'true' and not exists(select 1 from private.catalog_video_sets s where s.update_attempt_id=r.attempt_id) then
  return private.settle_unconfigured_catalog_variant_request(r);
 end if;$replace$);
 execute d;

 select pg_get_functiondef('public.service_resume_catalog_variant_round(uuid,uuid,uuid,uuid,uuid)'::regprocedure) into d;
 if strpos(d,$find$ if r.request_id is not null then return private.catalog_updater_variant_request_json(r);end if;$find$)=0
 then raise exception 'RESTITCH_SETTINGS_ROUND_RESUME_PATCH_MISSING';end if;
 d:=replace(d,$find$ if r.request_id is not null then return private.catalog_updater_variant_request_json(r);end if;$find$,
  $replace$ if r.request_id is not null then
  if r.settings_snapshot->>'configured' is distinct from 'true' and not exists(select 1 from private.catalog_video_sets s where s.update_attempt_id=r.attempt_id) then
   return private.settle_unconfigured_catalog_variant_request(r);
  end if;
  return private.catalog_updater_variant_request_json(r);
 end if;$replace$);
 execute d;

 -- 4. A round that ended before any request reads as ended.
 select pg_get_functiondef('public.service_read_catalog_updater_variants_before_foreground(uuid,uuid,uuid,uuid)'::regprocedure) into d;
 if strpos(d,$find$'state',case when original_state='cancelled'then 'canceled'else 'accepted'end$find$)=0
 then raise exception 'RESTITCH_SETTINGS_READ_PATCH_MISSING';end if;
 d:=replace(d,$find$'state',case when original_state='cancelled'then 'canceled'else 'accepted'end$find$,
  $replace$'state',case when original_state in('cancelled','failed')then 'canceled'else 'accepted'end$replace$);
 execute d;
end $patch$;
