-- A screen pool that is incomplete only because one of its chosen sources is
-- unavailable (deleted, not an image, or on a disconnected Google Drive) is not an
-- uncertain accounting outcome: the launch never starts and the person must pick
-- the pictures again. Report RESTITCH_SOURCES_INVALID for that case only.
begin;
do $capture$
declare d text;needle text:='  if pool->''complete'' is distinct from ''true''::jsonb then raise exception ''RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'' using errcode=''55000'';end if;';
begin
 select pg_get_functiondef('private.capture_catalog_video_restitch_context()'::regprocedure)into d;
 if (length(d)-length(replace(d,needle,'')))/length(needle)<>1 then raise exception 'RESTITCH_CAPTURE_SEAM_CHANGED';end if;
 d:=replace(d,needle,'  if pool->''complete'' is distinct from ''true''::jsonb and coalesce((pool->>''unknownSourceCount'')::integer,0)>0 then raise exception ''RESTITCH_SOURCES_INVALID'' using errcode=''22023'';end if;
'||needle);
 execute d;
end $capture$;
commit;
