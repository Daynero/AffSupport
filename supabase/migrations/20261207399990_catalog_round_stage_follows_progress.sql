-- 1.4.3 on next (production data): during a manager round with re-stitched videos the
-- row read «Готуємо відео для заміни…» from the start until success; the stages that
-- follow the videos never showed.
--
-- The stage read took the round's progress only from the worker holding the item's
-- lease, and otherwise fell back to the catalog's re-stitch record, which reads
-- 'restitching' for as long as that record says 'leased' — even once its lease has
-- expired. Progress recorded after the round became due belongs to this round
-- whichever worker wrote it, and a re-stitch whose lease is gone is no longer running.
begin;

do $patch$
declare d text;
begin
 d := pg_get_functiondef('public.list_team_product_catalogs(uuid)'::regprocedure);
 if strpos(d, 'and (progress.worker = item.lease_owner or (item.lease_owner is null and item.round_due_at is not null and progress.updated_at >= item.round_due_at))') = 0
  or strpos(d, $find$case when restitch.state = 'leased' then 'restitching'$find$) = 0 then
  raise exception 'CATALOG_STAGE_PATCH_MISSING';
 end if;
 d := replace(d,
  'and (progress.worker = item.lease_owner or (item.lease_owner is null and item.round_due_at is not null and progress.updated_at >= item.round_due_at))',
  'and item.round_due_at is not null and progress.updated_at >= item.round_due_at');
 d := replace(d,
  $find$case when restitch.state = 'leased' then 'restitching'$find$,
  $new$case when restitch.state = 'leased' and restitch.lease_expires_at > clock_timestamp() then 'restitching'$new$);
 execute d;
end $patch$;

commit;
