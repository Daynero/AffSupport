-- Beta 2026-11-11, set 4c9717d4 (QA: API gateway paused for 150 s during a
-- restitch): the agent stopped its own stitch after 90 s without a successful
-- heartbeat, as it must, and stayed online. Its next redeem of the same set came
-- from the SAME native instance, and the 2-minute silence takeover of
-- 20261207240000 runs only when a NEW native instance redeems. The variant
-- stayed 'working' with its operation 'running' until the 15-minute sweep, while
-- the dialog told the user the computer was not answering although it was.
--
-- A redeem by the instance that already executes the set now releases a variant
-- silent for 2 minutes exactly like a restarted agent's would. The agent redeems
-- only while it runs nothing for the set, and a live run heartbeats every 30 s
-- and stops itself after 90 s without one, so a variant silent for 2 minutes has
-- no writer left. The release keeps every guard of the takeover: no output, no
-- upload ownership, no provider result.
begin;

do $redeem$
declare d text;
 needle text:=$find$ if p_execution_native is not null and p_execution_native<>f.execution_native_instance_id then$find$;
begin
 select pg_get_functiondef('public.service_redeem_catalog_video_foreground(uuid,uuid,uuid,bytea,uuid,uuid)'::regprocedure) into d;
 if strpos(d,needle)=0 or strpos(d,'release_silent_catalog_video_variants')=0 then raise exception 'SAME_AGENT_TAKEOVER_SEAM_CHANGED';end if;
 d:=replace(d,needle,$add$ if p_execution_native is not null and p_execution_native=f.execution_native_instance_id and s.state in('accepted','preparing','unknown') then
  -- The same instance came back after its run stopped: same silence rule.
  perform private.release_silent_catalog_video_variants(s.id,interval '2 minutes');select *into s from private.catalog_video_sets where id=p_set;
 end if;
$add$||needle);
 execute d;
end $redeem$;

commit;
