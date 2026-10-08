-- 030 — retiring the legacy re-stitch image bucket, release C. NOT YET APPLICABLE.
--
-- GATE (FR-029): this file is applied only after
--   1. scripts/restitch-bucket-inventory.mjs has been run against production and its output
--      approved by the operator, object by object;
--   2. no space is still in legacy source mode with pictures it draws from the bucket:
--        select count(*) from public.team_restitch_defaults
--        where source_mode = 'legacy'
--          and cardinality(start_image_ids) + cardinality(end_image_ids) > 0;
--      and the same for public.team_member_restitch_preferences — both must be zero;
--   3. the web no longer reads the bucket (apps/web/src/team/restitch/images.ts is gone).
--
-- When those hold, replace the empty list below with the approved object names, verbatim,
-- and only then the SELECT policy and the bucket row may go. There is deliberately no
-- `delete from storage.objects where bucket_id = ...`: a deletion is a list, never a predicate.

do $$
declare
  approved text[] := '{}'::text[];
begin
  if cardinality(approved) = 0 then
    raise notice '030: no approved object list; the legacy bucket is left untouched';
    return;
  end if;
  delete from storage.objects
  where bucket_id = 'team-restitch-images' and name = any (approved);
  raise notice '030: removed % approved legacy objects', cardinality(approved);
end;
$$;
