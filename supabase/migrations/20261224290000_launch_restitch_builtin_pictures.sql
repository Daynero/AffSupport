-- Launches re-stitch out of the box too (owner, 2026-11-25: switched-on re-stitching never fails).
--
-- 20261224170000 made the space's effective settings stand Soty's standard pictures in for an
-- enabled slot without pictures of its own. Launches still had three ways to refuse:
-- 1. A redraw after the agent excluded a picture (prepare_launch_restitch with p_exclude) raised
--    SOURCE_CHANGED whenever the space's pictures had changed since acceptance — emptying the
--    pools included — and RESTITCH_POOL_EMPTY when the exclusion left nothing to draw.
-- 2. A first draw whose pools emptied between the effective read and the draw raised
--    RESTITCH_POOL_EMPTY.
-- 3. A space with BOTH screens turned off was silently re-stitched with the video's own end
--    frame, against the person's own choice.
--
-- Now every launch draw goes through private.launch_restitch_draw: a slot it cannot fill from the
-- pool falls back to the standard picture in the form agents up to 1.6.x render (no start, the
-- video's own last frame as the end; `builtin` names the slots, see 20261224170000). A redraw
-- after the pictures changed takes today's effective settings with the launch's own duration.
-- Both screens off is RESTITCH_INVALID, which the launch shows with the way to «Перезашивка».
-- SOURCE_CHANGED stays for the first draw of a launch whose reviewed settings changed, and for a
-- changed video.
--
-- The video-admission check (service_accept_launch_catalog_video_generation) compares the
-- settings drive-ops sends with the effective ones; a drive-ops built before the `builtin` field
-- drops it while parsing, so the comparison ignores `builtin` (it changes no rendered byte).

create function private.launch_restitch_draw(p_team uuid, p_pool_user uuid, p_settings jsonb, p_exclude uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare settings jsonb:=p_settings;start_on boolean;end_on boolean;
begin
 if settings->>'automaticEndFrame'='true' then
  return jsonb_build_object('defaults',settings,'draw',jsonb_build_object('sourceMode','drive',
   'pool',jsonb_build_object('start','empty','end','empty'),'screens','[]'::jsonb));
 end if;
 begin
  return jsonb_build_object('defaults',settings,'draw',private.draw_restitch_screens_for(p_team,p_pool_user,settings,coalesce(p_exclude,'{}')));
 exception when others then
  if sqlerrm<>'RESTITCH_POOL_EMPTY' then raise;end if;
 end;
 -- Nothing left to draw for an enabled slot: Soty's standard pictures.
 start_on:=settings->>'startEnabled' is distinct from 'false' or settings#>>'{builtin,start}'='true';
 end_on:=settings->>'endEnabled' is distinct from 'false' or settings#>>'{builtin,end}'='true';
 settings:=settings||jsonb_build_object('startEnabled',false,'endEnabled',true,'automaticEndFrame',true,
  'sourceMode','drive','startImageIds','[]'::jsonb,'endImageIds','[]'::jsonb,
  'builtin',jsonb_build_object('version',1,'start',start_on,'end',end_on));
 return jsonb_build_object('defaults',settings,'draw',jsonb_build_object('sourceMode','drive',
  'pool',jsonb_build_object('start','empty','end','empty'),'screens','[]'::jsonb));
end $$;
revoke all on function private.launch_restitch_draw(uuid,uuid,jsonb,uuid[]) from public,anon,authenticated,service_role;

do $patch$
declare d text;fn regprocedure;
begin
 select pg_get_functiondef('public.prepare_launch_restitch_unchecked(uuid,uuid,uuid[])'::regprocedure) into d;
 -- 3. Both screens off is the person's choice, not an automatic end frame.
 if strpos(d,$find$  if settings is null or settings->>'configured' is distinct from 'true' then
   settings:=jsonb_build_object('operation','restitch','startImageIds','[]'::jsonb,'endImageIds','[]'::jsonb,
    'fitMode','cover','startEnabled',false,'endEnabled',true,'startDurationMode','one-frame',
    'customStartDurationMs',100,'sourceMode','drive','configured',true,'automaticEndFrame',true,
    'finalDurationMode','custom','customFinalDurationSeconds',2700,'updatedAt','', 'updatedBy',null);
  end if;$find$)=0 then raise exception 'LAUNCH_RESTITCH_FALLBACK_PATCH_MISSING';end if;
 d:=replace(d,$find$  if settings is null or settings->>'configured' is distinct from 'true' then
   settings:=jsonb_build_object('operation','restitch','startImageIds','[]'::jsonb,'endImageIds','[]'::jsonb,
    'fitMode','cover','startEnabled',false,'endEnabled',true,'startDurationMode','one-frame',
    'customStartDurationMs',100,'sourceMode','drive','configured',true,'automaticEndFrame',true,
    'finalDurationMode','custom','customFinalDurationSeconds',2700,'updatedAt','', 'updatedBy',null);
  end if;$find$,
  $replace$  if settings is null or settings->>'configured' is distinct from 'true' then raise exception 'RESTITCH_INVALID' using errcode='55000';end if;$replace$);
 -- 2. The first draw falls back to the standard pictures.
 if strpos(d,$find$  if settings->>'automaticEndFrame'='true' then
   drawn:=jsonb_build_object('sourceMode','drive','pool',jsonb_build_object('start','empty','end','empty'),'screens','[]'::jsonb);
  else
   drawn:=private.draw_restitch_screens_for(p_team,pool_user,settings,'{}');
  end if;$find$)=0 then raise exception 'LAUNCH_RESTITCH_DRAW_PATCH_MISSING';end if;
 d:=replace(d,$find$  if settings->>'automaticEndFrame'='true' then
   drawn:=jsonb_build_object('sourceMode','drive','pool',jsonb_build_object('start','empty','end','empty'),'screens','[]'::jsonb);
  else
   drawn:=private.draw_restitch_screens_for(p_team,pool_user,settings,'{}');
  end if;$find$,
  $replace$  drawn:=private.launch_restitch_draw(p_team,pool_user,settings,'{}');
  settings:=drawn->'defaults';drawn:=drawn->'draw';$replace$);
 -- 1. A redraw goes on: today's settings when the pictures changed, the standard ones when none is left.
 if strpos(d,$find$  if private.launch_restitch_settings_version(p_team,g.actor_id) is distinct from r.sources->>'restitchSettingsVersion' then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  drawn:=private.draw_restitch_screens_for(p_team,pool_user,preparation.defaults,p_exclude);
  update private.launch_restitch_preparations set draw=drawn,excluded=p_exclude,draw_attempt=draw_attempt+1,updated_at=clock_timestamp()
   where generation_id=g.id returning * into preparation;$find$)=0 then raise exception 'LAUNCH_RESTITCH_REDRAW_PATCH_MISSING';end if;
 d:=replace(d,$find$  if private.launch_restitch_settings_version(p_team,g.actor_id) is distinct from r.sources->>'restitchSettingsVersion' then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  drawn:=private.draw_restitch_screens_for(p_team,pool_user,preparation.defaults,p_exclude);
  update private.launch_restitch_preparations set draw=drawn,excluded=p_exclude,draw_attempt=draw_attempt+1,updated_at=clock_timestamp()
   where generation_id=g.id returning * into preparation;$find$,
  $replace$  settings:=preparation.defaults;
  if private.launch_restitch_settings_version(p_team,g.actor_id) is distinct from r.sources->>'restitchSettingsVersion' then
   settings:=private.effective_restitch_defaults_json(p_team,g.actor_id);
   if settings is null or settings->>'configured' is distinct from 'true' then raise exception 'RESTITCH_INVALID' using errcode='55000';end if;
   -- The launch's own duration stays what was accepted.
   settings:=settings||jsonb_build_object('operation','restitch','finalDurationMode',preparation.defaults->'finalDurationMode',
    'customFinalDurationSeconds',preparation.defaults->'customFinalDurationSeconds');
  end if;
  drawn:=private.launch_restitch_draw(p_team,pool_user,settings,p_exclude);
  update private.launch_restitch_preparations set defaults=drawn->'defaults',draw=drawn->'draw',excluded=p_exclude,draw_attempt=draw_attempt+1,updated_at=clock_timestamp()
   where generation_id=g.id returning * into preparation;$replace$);
 execute d;

 -- Video admission: both screens off refuses; `builtin` is not compared.
 select p.oid::regprocedure into fn from pg_proc p where p.proname='service_accept_launch_catalog_video_generation' and p.pronamespace='public'::regnamespace;
 d:=pg_get_functiondef(fn);
 if strpos(d,$find$if base is null then base:=jsonb_build_object('operation','restitch','sourceMode','drive','startImageIds','[]'::jsonb,'endImageIds','[]'::jsonb,'fitMode','cover','configured',true,'startEnabled',false,'endEnabled',true,'automaticEndFrame',true,'startDurationMode','one-frame','customStartDurationMs',100);end if;$find$)=0
 then raise exception 'LAUNCH_VIDEO_FALLBACK_PATCH_MISSING';end if;
 d:=replace(d,$find$if base is null then base:=jsonb_build_object('operation','restitch','sourceMode','drive','startImageIds','[]'::jsonb,'endImageIds','[]'::jsonb,'fitMode','cover','configured',true,'startEnabled',false,'endEnabled',true,'automaticEndFrame',true,'startDurationMode','one-frame','customStartDurationMs',100);end if;$find$,
  $replace$if base is null then raise exception 'RESTITCH_INVALID' using errcode='55000';end if;$replace$);
 if strpos(d,$find$(settings-'updatedAt'-'updatedBy') is distinct from (base-'updatedAt'-'updatedBy')$find$)=0
 then raise exception 'LAUNCH_VIDEO_COMPARE_PATCH_MISSING';end if;
 d:=replace(d,$find$(settings-'updatedAt'-'updatedBy') is distinct from (base-'updatedAt'-'updatedBy')$find$,
  $replace$(settings-'updatedAt'-'updatedBy'-'builtin') is distinct from (base-'updatedAt'-'updatedBy'-'builtin')$replace$);
 execute d;
end $patch$;
