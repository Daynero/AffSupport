-- Owner decision 2026-11-11: a catalog with its video in R2 is deleted for good, and its copy
-- is removed at once so the space's limit is freed. On production (2026-11-12) a catalog sent
-- to the trash kept its copy: the five-minute sweep that releases the uses of trashed
-- catalogs only started when something else was already due
-- (`private.catalog_video_r2_has_work`), so nothing ever released it.
--
-- Now the trash itself releases: when a catalog becomes trashed (or missing because it was
-- removed) its R2 uses are dropped in the same transaction, the copies nobody else uses are
-- made due for deletion, and the worker is woken to delete them. The sweep also counts such
-- uses as work, as the safety net for a wake-up that was lost.

create function private.catalog_video_r2_release_removed(p_catalog uuid) returns integer
language plpgsql security definer set search_path='' as $$
declare released uuid[]; n integer:=0;
begin
 with gone as (
  delete from private.catalog_video_r2_uses u
   using public.team_materials m
   where m.id=u.catalog_material_id and (p_catalog is null or m.id=p_catalog)
    and ((m.lifecycle='missing' and m.missing_reason='removed') or m.lifecycle='trashed')
   returning u.copy_id)
 select coalesce(array_agg(distinct copy_id),'{}') into released from gone;
 -- The use trigger made each copy nobody uses 'retiring' with the grace window; a removed
 -- catalog skips the window.
 update private.catalog_video_r2_copies set retire_after=clock_timestamp()
  where id=any(released) and state='retiring'
   and not exists(select 1 from private.catalog_video_r2_uses u where u.copy_id=catalog_video_r2_copies.id);
 get diagnostics n=row_count;
 return n;
end $$;
revoke all on function private.catalog_video_r2_release_removed(uuid) from public,anon,authenticated,service_role;

create function private.catalog_video_r2_after_catalog_removed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.catalog_video_r2_uses where catalog_material_id=new.id) then
  -- Never let the R2 follow-up stop the trash itself; the sweep is the safety net.
  begin
   if private.catalog_video_r2_release_removed(new.id)>0 then
    perform private.invoke_catalog_video_r2_worker('sweep');
   end if;
  exception when others then null;
  end;
 end if;
 return null;
end $$;
revoke all on function private.catalog_video_r2_after_catalog_removed() from public,anon,authenticated,service_role;
create trigger catalog_video_r2_after_catalog_removed after update of lifecycle,missing_reason on public.team_materials
 for each row when ((new.lifecycle='trashed' or (new.lifecycle='missing' and new.missing_reason='removed'))
  and (old.lifecycle is distinct from new.lifecycle or old.missing_reason is distinct from new.missing_reason))
 execute function private.catalog_video_r2_after_catalog_removed();

do $patch$
declare d text;
begin
 select pg_get_functiondef('private.catalog_video_r2_has_work(text)'::regprocedure) into d;
 if strpos(d,$find$else exists(select 1 from private.catalog_video_r2_copies where state='retiring' and retire_after<=clock_timestamp())$find$)=0
 then raise exception 'R2_SWEEP_WORK_PATCH_MISSING';end if;
 d:=replace(d,$find$else exists(select 1 from private.catalog_video_r2_copies where state='retiring' and retire_after<=clock_timestamp())$find$,
  $replace$else exists(select 1 from private.catalog_video_r2_copies where state='retiring' and retire_after<=clock_timestamp())
   or exists(select 1 from private.catalog_video_r2_uses u join public.team_materials m on m.id=u.catalog_material_id where m.lifecycle='trashed' or (m.lifecycle='missing' and m.missing_reason='removed'))$replace$);
 execute d;
end $patch$;
