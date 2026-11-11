-- Two leftovers from 1.4.3 QA round 6.
--
-- 1. The manager row lagged its round by minutes. service_complete_catalog_update
--    releases the worker's lease (lease_owner and lease_expires_at go null) while
--    the round itself stays due until delivery is confirmed, about two minutes
--    later. The stage read joined progress only to the live lease owner, so the
--    whole finalizing stretch read as 'preparing' and the row kept showing the
--    last stage it had seen («Оновлюємо картинки…»). Once the lease is released,
--    the progress recorded for this round still belongs to it.
--
-- 2. A set that closed as canceled could keep a variant 'working' whose operation
--    had already ended (failed or canceled). 395000 closed only operation-less
--    variants. Such a variant now goes to 'unknown', the state every other
--    variant of a canceled set with an ended operation already has, and stops
--    counting as work in progress.
begin;

do $patch$
declare d text;
begin
 d := pg_get_functiondef('public.list_team_product_catalogs(uuid)'::regprocedure);
 if strpos(d, 'and progress.worker = item.lease_owner') = 0 then
  raise exception 'CATALOG_STAGE_PATCH_MISSING';
 end if;
 d := replace(d, 'and progress.worker = item.lease_owner',
  'and (progress.worker = item.lease_owner or (item.lease_owner is null and item.round_due_at is not null and progress.updated_at >= item.round_due_at))');
 execute d;

 d := pg_get_functiondef('public.list_team_catalog_progress_identity(uuid)'::regprocedure);
 if strpos(d, $find$case when progress.worker = item.lease_owner
      and progress.updated_at >= item.round_due_at
      and item.lease_expires_at > now() then active.attempt_id end$find$) = 0 then
  raise exception 'CATALOG_PROGRESS_IDENTITY_PATCH_MISSING';
 end if;
 d := replace(d, $find$case when progress.worker = item.lease_owner
      and progress.updated_at >= item.round_due_at
      and item.lease_expires_at > now() then active.attempt_id end$find$,
  $new$case when ((progress.worker = item.lease_owner and item.lease_expires_at > now())
        or item.lease_owner is null)
      and progress.updated_at >= item.round_due_at then active.attempt_id end$new$);
 execute d;
end $patch$;

create or replace function private.catalog_video_set_canceled_closes_variants() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update private.catalog_video_variants set state='queued',heartbeat_at=null,silence_observed_at=null
  where video_set_id=new.id and state='working' and operation_id is null and output_material_id is null;
 update private.catalog_video_variants v set state='unknown',heartbeat_at=null,silence_observed_at=null
  from public.team_operations o
  where v.video_set_id=new.id and v.state='working' and v.output_material_id is null
   and o.id=v.operation_id and o.state in('failed','canceled');
 return null;
end $$;
revoke all on function private.catalog_video_set_canceled_closes_variants() from public,anon,authenticated,service_role;

update private.catalog_video_variants v set state='unknown',heartbeat_at=null,silence_observed_at=null
 from private.catalog_video_sets s, public.team_operations o
 where s.id=v.video_set_id and s.state='canceled' and v.state='working' and v.output_material_id is null
  and o.id=v.operation_id and o.state in('failed','canceled');

commit;
