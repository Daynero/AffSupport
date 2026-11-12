-- Production 2026-11-12 (КАТАЛОГИ, set f48e7d9e): the person canceled a 10-variation update at
-- 22:27:25; variant 0's run finished two seconds later, succeeded and published its output to
-- Drive, but the canceled set never registered it. 399920/399995 let a succeeded run pass the
-- cancellation only when its output had gone; this one is active, so the set stayed
-- 'cancel_requested' («Скасовуємо…») for good and kept the updater awake every minute.
--
-- A succeeded run whose upload was published and that finished more than five minutes ago has
-- settled: nothing of it is still running, and a registration that has not landed by then will
-- not. Its output stays in Drive as an ordinary file of the space; nothing is deleted. A run
-- that finished within five minutes keeps the cancellation waiting exactly as before, and every
-- other guard (executor quiescence, claims, fences, grants, transfers) stays.
begin;

create or replace function private.catalog_variant_output_settled(p_operation uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select private.catalog_variant_output_gone(p_operation)
  or exists(
   select 1 from public.team_operations o
   join private.process_upload_ownership w on w.operation_id=o.id and w.upload_state='published'
   where o.id=p_operation and o.state='succeeded' and o.result_material_id is not null
    and coalesce(o.finished_at,o.updated_at)<=clock_timestamp()-interval '5 minutes')
$$;
revoke all on function private.catalog_variant_output_settled(uuid) from public,anon,authenticated,service_role;

do $quiescent$
declare d text;
 marker text:='private.catalog_variant_output_settled(o.id)';
 needle text:='private.catalog_variant_output_gone(o.id)';
begin
 select pg_get_functiondef('private.catalog_video_cancel_quiescent(uuid)'::regprocedure) into d;
 if strpos(d,marker)>0 then return; end if;
 -- The result check, the provider check, the upload settlement and the terminal-state check.
 if (length(d)-length(replace(d,needle,'')))/length(needle)<>4 then
  raise exception 'CANCEL_PUBLISHED_OUTPUT_SEAM_CHANGED';
 end if;
 d:=replace(d,needle,marker);
 execute d;
end $quiescent$;

commit;
