-- A screen pool that is incomplete because a chosen source is unavailable (its file
-- deleted or trashed, not an image, or on a disconnected Google Drive) is not an
-- uncertain accounting outcome: the launch never starts and the person must pick
-- the pictures again. Report RESTITCH_SOURCES_INVALID for that case only. A source
-- that is not indexed yet (no material row) stays RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN.
begin;
do $capture$
declare d text;needle text:='  if pool->''complete'' is distinct from ''true''::jsonb then raise exception ''RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'' using errcode=''55000'';end if;';
begin
 select pg_get_functiondef('private.capture_catalog_video_restitch_context()'::regprocedure)into d;
 if (length(d)-length(replace(d,needle,'')))/length(needle)<>1 then raise exception 'RESTITCH_CAPTURE_SEAM_CHANGED';end if;
 d:=replace(d,needle,'  if pool->''complete'' is distinct from ''true''::jsonb and exists(select 1 from public.team_restitch_sources src join public.team_materials sm on sm.id=src.material_id left join public.team_drive_connections sd on sd.id=sm.connection_id
   where src.team_id=new.team_id and src.slot=selected_slot and src.user_id is not distinct from (ctx->>''poolUserId'')::uuid
   and (sm.lifecycle<>''active'' or sm.kind is distinct from src.kind or (src.kind=''file'' and sm.category is distinct from ''image'') or sd.id is null or sd.state<>''connected''))
  then raise exception ''RESTITCH_SOURCES_INVALID'' using errcode=''22023'';end if;
'||needle);
 execute d;
end $capture$;
commit;
