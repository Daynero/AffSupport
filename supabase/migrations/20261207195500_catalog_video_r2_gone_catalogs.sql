-- 050: a catalog deleted for good lets go of its R2 videos.
--
-- Catalog materials are never hard-deleted: a sheet taken out of Drive becomes
-- `missing` (reason `removed`) or `trashed`, and the row stays. The copy's use
-- rows cascade only from a deleted row, so a deleted catalog kept its R2 video
-- for ever: public, counted against the space limit, cleaned up only with the
-- whole space. Found during the final beta pass.
--
-- FR-012 keeps the copy while the catalog is in the trash (the issued sheet
-- still points at it and a restore must not break), so only these release it:
-- - `missing` with reason `removed`: the sheet was deleted from Drive for good
--   (a file merely moved out of the watched folder is `out_of_root` and keeps
--   its copy);
-- - `trashed` for more than 30 days: Drive empties its trash after 30 days.
-- Releasing deletes the use rows; the existing `catalog_video_r2_use_removed`
-- trigger then retires a copy no other catalog uses, after the usual grace
-- window, and the sweep deletes it from the bucket. A catalog restored later
-- is active again and plans a fresh copy through the normal reconciliation.
-- The release runs at the start of the sweep's orphan pass (every 5 minutes),
-- so no new job or worker route is needed.

create or replace function public.service_catalog_video_r2_retire_orphans() returns integer language plpgsql security definer set search_path='' as $$
declare cfg private.catalog_video_r2_config%rowtype; n integer:=0; c record;
begin
 select * into cfg from private.catalog_video_r2_config where singleton;
 delete from private.catalog_video_r2_uses u
  using public.team_materials m
  where m.id=u.catalog_material_id
   and ((m.lifecycle='missing' and m.missing_reason='removed')
    or (m.lifecycle='trashed' and m.trashed_at<clock_timestamp()-interval '30 days'));
 for c in select * from private.catalog_video_r2_copies where state='ready' and ready_at<clock_timestamp()-cfg.grace_interval and not exists(select 1 from private.catalog_video_r2_uses u where u.copy_id=catalog_video_r2_copies.id) for update skip locked loop
  update private.catalog_video_r2_copies set state='retiring',retire_after=clock_timestamp()+cfg.grace_interval,retire_reason='replaced',fence=fence+1 where id=c.id;
  perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'retiring',null,null,null,c.size_bytes);
  n:=n+1;
 end loop;
 return n;
end $$;
revoke all on function public.service_catalog_video_r2_retire_orphans() from public,anon,authenticated;
grant execute on function public.service_catalog_video_r2_retire_orphans() to service_role;
