-- Beta 2026-11-11, set a0f1fd63 (TR 7): under load one variant heartbeat timed
-- out at the gateway and the 1.4.2/1.4.3 agent aborted its own stitch. It
-- recorded the variant 'unknown' but could not close its operation, which stayed
-- 'running'. The silence takeover and the 15-minute sweep of 20261207240000 look
-- only at 'working' variants, so such a variant waited for the 12-hour
-- abandonment rule while its set showed "unknown" (the agent no longer
-- stops on one lost heartbeat; this repairs the state any agent can still leave).
--
-- An 'unknown' variant whose operation is still pending/running, owns no output,
-- no upload and no provider result, and has shown no sign of life is now taken
-- over and swept exactly like a silent 'working' one: failed, its name released
-- (20261207320000), and requeued within the retry budget. Sets already stuck
-- this way are picked up by the per-minute settlement after the usual
-- 15 minutes plus a confirming second observation.
begin;

create or replace function private.release_silent_catalog_video_variants(p_set uuid,p_silence interval) returns integer language plpgsql security definer set search_path='' as $$
declare s private.catalog_video_sets%rowtype;v private.catalog_video_variants%rowtype;o public.team_operations%rowtype;answer jsonb;n integer:=0;
begin
 select * into s from private.catalog_video_sets where id=p_set for update;
 if s.id is null or s.state not in('accepted','preparing','unknown') then return 0;end if;
 for v in select * from private.catalog_video_variants where video_set_id=p_set and state in('working','unknown') and output_material_id is null order by video_variant_index for update loop
  select * into o from public.team_operations where team_id=s.team_id and actor_id=s.actor_id and kind='process' and idempotency_key='catalog-variant:'||v.request_id::text for update;
  if o.id is null or o.state not in('pending','running') or o.result_material_id is not null
   or exists(select 1 from private.process_upload_ownership w where w.operation_id=o.id)
   or exists(select 1 from private.team_operation_intents i where i.operation_id=o.id and i.provider_result_id is not null) then continue;end if;
  if private.catalog_video_variant_last_life(p_set,v.video_variant_index,o.id)>clock_timestamp()-p_silence then continue;end if;
  update public.team_operations set state='failed',error_code='PROCESS_RESULT_UNCERTAIN',retryable=false,finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=o.id;
  answer:=private.retry_failed_catalog_video_variant(p_set,v.video_variant_index);
  if answer->>'kind' in('retry','registered') then n:=n+1;
  else
   update private.catalog_video_variants set state='unknown' where video_set_id=p_set and video_variant_index=v.video_variant_index and state='working';
   update private.catalog_video_sets set state='unknown',revision=revision+1,updated_at=clock_timestamp() where id=p_set and state in('accepted','preparing');
  end if;
 end loop;
 return n;
end;$$;
revoke all on function private.release_silent_catalog_video_variants(uuid,interval) from public,anon,authenticated,service_role;

-- The per-minute settlement sweeps silent 'unknown' variants with a live
-- operation too.
do $settle$
declare d text;
 needle1 text:=$find$where v.video_set_id=silent.id and v.state='working' and o.state in('pending','running')$find$;
 needle2 text:=$find$for idx in select video_variant_index from private.catalog_video_variants where video_set_id=active.id and state='working' order by video_variant_index loop$find$;
begin
 select pg_get_functiondef('public.service_settle_catalog_video_cancellations(integer)'::regprocedure) into d;
 if strpos(d,needle1)=0 or strpos(d,needle2)=0 then raise exception 'VARIANT_UNKNOWN_SWEEP_SEAM_CHANGED';end if;
 d:=replace(d,needle1,$replace$where v.video_set_id=silent.id and v.state in('working','unknown') and o.state in('pending','running')$replace$);
 d:=replace(d,needle2,$replace$for idx in select video_variant_index from private.catalog_video_variants where video_set_id=active.id and state in('working','unknown') order by video_variant_index loop$replace$);
 execute d;
end $settle$;

commit;
