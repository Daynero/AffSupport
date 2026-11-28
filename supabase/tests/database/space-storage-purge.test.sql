begin;
select plan(62);

-- 057 T058 (20261226380000): what the sweeper of R2 spaces is handed and how it closes it (US10,
-- FR-048, FR-049, SC-014, SC-016). Purges get the due time of their reason; the claim keeps what
-- came back and waits for an open upload of the same content; shared objects stay; a repeat is a
-- no-op; the trash expires after 30 days; a restore into a full space is refused; a deleted space
-- leaves a tombstone; the daily reconciliation finds orphans and missing objects; the catalogs of
-- R2 spaces are claimed in a batch, Drive's never.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05758000-0000-4000-8000-000000000001','authenticated','authenticated','purge-owner@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values ('05758000-0000-4000-8000-000000000001',100000);

create temporary table seen(label text, value jsonb);
create function pg_temp.team() returns uuid language sql as $$ select (value->>'teamId')::uuid from seen where label='space' $$;
create function pg_temp.root() returns uuid language sql as $$ select (value->>'rootMaterialId')::uuid from seen where label='space' $$;
create function pg_temp.v(p_label text) returns jsonb language sql as $$ select value from seen where label=p_label $$;
create function pg_temp.owner() returns uuid language sql as $$ select '05758000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.admit(p_key text, p_content text, p_bytes bigint) returns jsonb language sql as $$
  select public.service_admit_space_upload(pg_temp.owner(), jsonb_build_object('teamId',pg_temp.team(),'parentMaterialId',pg_temp.root(),
    'name','File '||p_key||'.png','contentType','image/png','bytes',p_bytes::text,'contentId',p_content,'ingress','explorer',
    'idempotencyKey','purge-key-'||p_key||'-000000','category','image','classificationSource','mime','fileExtension','png')) $$;
create function pg_temp.upload(p_key text, p_content text, p_bytes bigint) returns uuid language plpgsql as $$
declare a jsonb;
begin
  a := pg_temp.admit(p_key, p_content, p_bytes);
  perform public.service_attach_space_upload((a->>'uploadId')::uuid, pg_temp.owner(), 'r2-'||p_key);
  perform public.service_mark_space_upload_completing((a->>'uploadId')::uuid, pg_temp.team(), pg_temp.owner(), p_content, repeat('e',32)||'-1');
  return (public.service_complete_space_upload((a->>'uploadId')::uuid, pg_temp.team(), pg_temp.owner(), '{}'::jsonb)->>'id')::uuid;
end $$;
create function pg_temp.object_of(p_material uuid) returns uuid language sql as $$
  select space_object_id from public.team_materials where id=p_material $$;
create function pg_temp.mutate(p_action text, p_ids uuid[]) returns jsonb language sql as $$
  select public.service_mutate_space_materials(pg_temp.owner(), pg_temp.team(),
    jsonb_build_object('action',p_action,'materialIds',to_jsonb(p_ids))) $$;
create function pg_temp.purge(p_object uuid) returns text language sql as $$
  select reason||':'||state||':'||case when due_at<=now() then 'now' when due_at>=now()+interval '23 hours' then 'day' else 'other' end
  from public.space_object_purges where object_id=p_object $$;

insert into seen select 'space', public.service_create_r2_space(pg_temp.owner(),'Purge space','purge-space-key-0001');

-- 1. Each reason, its due time ------------------------------------------------------------------
insert into seen select 'a', to_jsonb(pg_temp.upload('a', repeat('a',64), 100));
insert into seen select 'b', to_jsonb(pg_temp.upload('b', repeat('b',64), 200));
insert into seen select 'c', to_jsonb(pg_temp.upload('c', repeat('c',64), 300));
insert into seen select 'd', to_jsonb(pg_temp.upload('d', repeat('d',64), 400));
select pg_temp.mutate('trash', array[(pg_temp.v('a')#>>'{}')::uuid]);
select public.service_empty_space_trash(pg_temp.owner(), pg_temp.team(), null);
select is(pg_temp.purge(pg_temp.object_of((pg_temp.v('a')#>>'{}')::uuid)), null, 'the emptied material''s object row is gone with it');
select is((select pg_temp.purge(o.id) from public.space_objects o where o.team_id=pg_temp.team() and o.content_id=repeat('a',64)),
 'trash_emptied:due:now','«Очистити кошик»: due at once');
-- No transaction named a reason (a path that just deleted the row): an orphan, due after a day.
delete from public.team_materials where id=(pg_temp.v('b')#>>'{}')::uuid;
select is((select pg_temp.purge(o.id) from public.space_objects o where o.team_id=pg_temp.team() and o.content_id=repeat('b',64)),
 'orphan:due:day','an unnamed removal waits a day, the grace an orphan gets');
-- Thirty days in the trash.
select pg_temp.mutate('trash', array[(pg_temp.v('c')#>>'{}')::uuid]);
select is(public.service_expire_space_trash(200), 0, 'a fresh trash stays');
update public.team_materials set trashed_at=now()-interval '31 days' where id=(pg_temp.v('c')#>>'{}')::uuid;
select ok(private.space_storage_sweeper_has_work(), 'an expired trash is work for the sweeper');
select is(public.service_expire_space_trash(200), 1, 'after thirty days it goes for good');
select is((select pg_temp.purge(o.id) from public.space_objects o where o.team_id=pg_temp.team() and o.content_id=repeat('c',64)),
 'trash_expired:due:now','due at once, with its reason');

-- 2. Shared stays, a repeat is a no-op -------------------------------------------------------------
insert into seen select 'dcopy', pg_temp.mutate('copy', array[(pg_temp.v('d')#>>'{}')::uuid])->'materials'->0->'id';
select pg_temp.mutate('trash', array[(pg_temp.v('d')#>>'{}')::uuid]);
insert into seen select 'empty1', public.service_empty_space_trash(pg_temp.owner(), pg_temp.team(), null);
select is((pg_temp.v('empty1')->>'deleted')||':'||(pg_temp.v('empty1')->>'purgesQueued'),'1:0','one of two holders goes; nothing is queued');
select is((select state from public.space_objects where team_id=pg_temp.team() and content_id=repeat('d',64)),'committed',
 'the object the copy still holds stays');
insert into seen select 'empty2', public.service_empty_space_trash(pg_temp.owner(), pg_temp.team(), null);
select is((pg_temp.v('empty2')->>'deleted')||':'||(pg_temp.v('empty2')->>'purgesQueued'),'0:0','emptying again changes nothing');

-- 3. The claim -------------------------------------------------------------------------------------
-- An open upload of the same content writes the very key: the purge waits for it.
insert into seen select 'e', to_jsonb(pg_temp.upload('e', repeat('5',64), 50));
select pg_temp.mutate('trash', array[(pg_temp.v('e')#>>'{}')::uuid]);
select public.service_empty_space_trash(pg_temp.owner(), pg_temp.team(), null);
-- A second upload of the same bytes revives it; a third, of content with an upload still open,
-- is what the claim must wait for.
insert into seen select 'f', to_jsonb(pg_temp.upload('f', repeat('6',64), 60));
select pg_temp.mutate('trash', array[(pg_temp.v('f')#>>'{}')::uuid]);
select public.service_empty_space_trash(pg_temp.owner(), pg_temp.team(), null);
insert into seen select 'open6', pg_temp.admit('f-again', repeat('6',64), 60);
select is(pg_temp.v('open6')->>'kind', 'exists', 'bytes not yet deleted are used again (revive)');
select is((select state from public.space_objects where team_id=pg_temp.team() and content_id=repeat('6',64) and kind='original'),
 'committed', 'and the object is live again');
-- Simulate the race the claim must survive: an object queued while an upload of it is still open.
update public.space_objects set state='purge_pending' where team_id=pg_temp.team() and content_id=repeat('5',64);
insert into seen select 'open5', pg_temp.admit('e-open', repeat('7',64), 70);
update public.space_uploads set declared_content_id=repeat('5',64) where id=(pg_temp.v('open5')->>'uploadId')::uuid;
insert into seen select 'claim1', public.service_claim_space_object_purges('sweeper-test-1', 50);
select is((select count(*)::integer from jsonb_array_elements(pg_temp.v('claim1')) c
  where c->>'key' like '%/o/'||repeat('5',64)), 0, 'an object with an open upload of its content is not handed out');
select ok((select next_attempt_at > now() from public.space_object_purges p join public.space_objects o on o.id=p.object_id
  where o.content_id=repeat('5',64) and o.team_id=pg_temp.team()), 'it waits a few minutes');
select is((select string_agg(split_part(c->>'key','/',4), ',' order by c->>'key') from jsonb_array_elements(pg_temp.v('claim1')) c),
 repeat('a',64)||','||repeat('c',64), 'the due ones are handed out; the orphan''s day has not come');
select is((select attempts||':'||(lease_until is not null) from public.space_object_purges p join public.space_objects o on o.id=p.object_id
  where o.content_id=repeat('a',64) and o.team_id=pg_temp.team()), '1:true', 'a handed-out purge counts its attempt and holds a lease');
select is(public.service_claim_space_object_purges('sweeper-test-2', 50), '[]'::jsonb, 'a held lease is not handed out twice');
select throws_ok($$select public.service_admit_space_upload(pg_temp.owner(), jsonb_build_object('teamId',pg_temp.team(),
  'parentMaterialId',pg_temp.root(),'name','A again.png','contentType','image/png','bytes','100','contentId',repeat('a',64),
  'ingress','explorer','idempotencyKey','purge-key-a-again-0000'))$$, 'STORAGE_UNAVAILABLE',
 'the same content while its deletion is in flight is retryable, not revived');

-- 4. Finishing -------------------------------------------------------------------------------------
select public.service_finish_space_object_purge((c->>'objectId')::uuid, (c->>'fence')::bigint, true, null)
  from jsonb_array_elements(pg_temp.v('claim1')) c where c->>'key' like '%/o/'||repeat('a',64);
select is((select o.state||':'||(o.purged_at is not null)||':'||p.state from public.space_objects o join public.space_object_purges p on p.object_id=o.id
  where o.content_id=repeat('a',64) and o.team_id=pg_temp.team()), 'purged:true:deleted', 'a deleted object is purged');
select ok(exists(select 1 from private.space_storage_journal where stage='purge' and outcome='ok' and team_id=pg_temp.team() and bytes=100),
 'and the journal says so, without its key');
select throws_ok(format($$select public.service_finish_space_object_purge('%s', %s, true, null)$$,
 (select c->>'objectId' from jsonb_array_elements(pg_temp.v('claim1')) c where c->>'key' like '%/o/'||repeat('a',64)),
 (select c->>'fence' from jsonb_array_elements(pg_temp.v('claim1')) c where c->>'key' like '%/o/'||repeat('a',64))),
 'LEASE_MISMATCH', 'finishing twice is refused');
select public.service_finish_space_object_purge((c->>'objectId')::uuid, (c->>'fence')::bigint, false, 'STORAGE_UNAVAILABLE')
  from jsonb_array_elements(pg_temp.v('claim1')) c where c->>'key' like '%/o/'||repeat('c',64);
select is((select p.state||':'||p.last_error_code||':'||(p.next_attempt_at > now()) from public.space_object_purges p join public.space_objects o on o.id=p.object_id
  where o.content_id=repeat('c',64) and o.team_id=pg_temp.team()), 'due:STORAGE_UNAVAILABLE:true', 'a failed deletion is tried again later');
select is((select state from public.space_objects where content_id=repeat('c',64) and team_id=pg_temp.team()), 'purge_pending',
 'and its object is still pending');
-- The same bytes uploaded after the purge are a new object.
insert into seen select 'a2', to_jsonb(pg_temp.upload('a2', repeat('a',64), 100));
select is((select count(*)::integer from public.space_objects where team_id=pg_temp.team() and content_id=repeat('a',64)), 2,
 'uploaded again after deletion it is a new object');

-- 5. Restore: links come back, a full space refuses ---------------------------------------------------
insert into seen select 'g', to_jsonb(pg_temp.upload('g', repeat('8',64), 500));
select pg_temp.mutate('trash', array[(pg_temp.v('g')#>>'{}')::uuid]);
select is((select category from public.space_object_refs where owner_kind='material' and owner_id=(pg_temp.v('g')#>>'{}')::uuid),
 'trash','in the trash it counts as trash');
select pg_temp.mutate('restore', array[(pg_temp.v('g')#>>'{}')::uuid]);
select is((select category from public.space_object_refs where owner_kind='material' and owner_id=(pg_temp.v('g')#>>'{}')::uuid),
 'materials','restored, its reference counts as a file again');
select pg_temp.mutate('trash', array[(pg_temp.v('g')#>>'{}')::uuid]);
update public.storage_r2_pilots set max_space_bytes=10 where user_id=pg_temp.owner();
select throws_ok($$select pg_temp.mutate('restore', array[(pg_temp.v('g')#>>'{}')::uuid])$$, 'STORAGE_QUOTA_EXCEEDED',
 'a space over its limit takes nothing back from the trash');
select is((select lifecycle from public.team_materials where id=(pg_temp.v('g')#>>'{}')::uuid), 'trashed', 'and the file stays there');
update public.storage_r2_pilots set max_space_bytes=100000 where user_id=pg_temp.owner();

-- 6. Uploads past their time ------------------------------------------------------------------------
insert into seen select 'late', pg_temp.admit('late', repeat('9',64), 90);
select public.service_attach_space_upload((pg_temp.v('late')->>'uploadId')::uuid, pg_temp.owner(), 'r2-late');
update public.space_uploads set expires_at=now()-interval '1 minute' where id=(pg_temp.v('late')->>'uploadId')::uuid;
select ok(public.service_expire_space_uploads(200) >= 1, 'an open upload past its time expires without its uploader');
select is((select r.state from public.space_storage_reservations r join public.space_uploads u on u.reservation_id=r.id
  where u.id=(pg_temp.v('late')->>'uploadId')::uuid), 'uncertain', 'its reservation waits for the multipart');
insert into seen select 'uncertain', public.service_claim_space_uncertain_uploads(50);
select is((select (c->>'key')||':'||(c->>'r2UploadId')||':'||(c->>'lifecycleAborted') from jsonb_array_elements(pg_temp.v('uncertain')) c
  where c->>'uploadId'=pg_temp.v('late')->>'uploadId'), 't/'||pg_temp.team()||'/o/'||repeat('9',64)||':r2-late:false',
 'the sweeper is told which multipart to abort');
select is(public.service_settle_space_uncertain_upload((pg_temp.v('late')->>'uploadId')::uuid, false), false,
 'not closed and younger than the lifecycle rule: it stays reserved');
update public.space_uploads set expires_at=now()-interval '25 hours' where id=(pg_temp.v('late')->>'uploadId')::uuid;
select is(public.service_settle_space_uncertain_upload((pg_temp.v('late')->>'uploadId')::uuid, false), true,
 'past the bucket''s one-day multipart rule it is released anyway');
select is((select r.state from public.space_storage_reservations r join public.space_uploads u on u.reservation_id=r.id
  where u.id=(pg_temp.v('late')->>'uploadId')::uuid), 'released', 'and the space has its room back');

-- 7. Daily reconciliation -------------------------------------------------------------------------
insert into public.teams(id,name,owner_id) values ('05758000-0000-4000-8000-0000000000d1','Drive space',pg_temp.owner());
select is(public.service_start_space_reconciliations() >= 1, true, 'a reconciliation starts for each R2 space');
select is((select count(*)::integer from public.space_storage_reconciliations where team_id='05758000-0000-4000-8000-0000000000d1'), 0,
 'never for a Drive space');
select is(public.service_start_space_reconciliations(), 0, 'and once a day');
update public.space_storage_reconciliations set started_at=now()+interval '1 second' where team_id=pg_temp.team();
delete from seen where label='claimr';
insert into seen select 'claimr', public.service_claim_space_reconciliation('sweeper-test-1');
-- A page: a known object, an old orphan, a fresh one and a stray staging key; the 'd' object is not listed.
insert into seen select 'page', public.service_space_reconcile_page((pg_temp.v('claimr')->>'reconciliationId')::uuid,
 (pg_temp.v('claimr')->>'fence')::bigint, jsonb_build_array(
   jsonb_build_object('key','t/'||pg_temp.team()||'/o/'||repeat('0',64),'etag','"x"','lastModified',(now()-interval '3 days')::text),
   jsonb_build_object('key','t/'||pg_temp.team()||'/o/'||repeat('1',64),'etag','"y"','lastModified',now()::text),
   jsonb_build_object('key','t/'||pg_temp.team()||'/o/'||repeat('8',64),'etag','"z"','lastModified',(now()-interval '3 days')::text)),
 2, true);
select is(pg_temp.v('page')->'orphans', jsonb_build_array(jsonb_build_object('key','t/'||pg_temp.team()||'/o/'||repeat('0',64),'etag','"x"')),
 'only the orphan past its day is handed out for deletion');
select is((select listed||':'||orphans_found||':'||orphans_waiting||':'||foreign_keys||':'||state from public.space_storage_reconciliations
  where id=(pg_temp.v('claimr')->>'reconciliationId')::uuid), '3:2:1:2:done', 'listed, orphans, waiting and stray keys are counted');
select ok((select missing from public.space_storage_reconciliations where id=(pg_temp.v('claimr')->>'reconciliationId')::uuid) >= 2,
 'committed objects the listing never showed are missing');
select ok(exists(select 1 from private.space_storage_journal where stage='reconcile' and outcome='failed' and code='NOT_FOUND'
  and team_id=pg_temp.team()), 'a reconciliation with missing objects is an error in the journal');
select throws_ok(format($$select public.service_space_reconcile_page('%s', 999, '[]'::jsonb, 0, true)$$,
 pg_temp.v('claimr')->>'reconciliationId'), 'LEASE_MISMATCH', 'a stale fence changes nothing');

-- 8. Catalogs of R2 spaces --------------------------------------------------------------------------
insert into seen select 'video', to_jsonb(pg_temp.upload('video', repeat('f',64), 700));
insert into private.catalog_video_r2_copies(team_id,source_material_id,source_version,state,size_bytes,part_bytes,retire_after,retire_reason)
values (pg_temp.team(),(pg_temp.v('video')#>>'{}')::uuid,repeat('f',64),'retiring',700,5242880,now()-interval '1 second','catalog_deleted');
insert into private.catalog_video_r2_copies(team_id,source_material_id,source_version,state,size_bytes,part_bytes,retire_after,retire_reason)
values ('05758000-0000-4000-8000-0000000000d1',(pg_temp.v('video')#>>'{}')::uuid,'drive-v1','retiring',700,5242880,now()-interval '1 second','catalog_deleted');
insert into seen select 'retire', public.service_space_catalog_claim_retire('sweeper-test-1', 30);
select is((select array_agg(c->>'teamId') from jsonb_array_elements(pg_temp.v('retire')) c), array[pg_temp.team()::text],
 'the retiring copies of R2 spaces are claimed in one batch; a Drive space''s never');
select is((select lease_owner||':'||fence from private.catalog_video_r2_copies where id=(pg_temp.v('retire')->0->>'copyId')::uuid),
 'sweeper-test-1:'||(pg_temp.v('retire')->0->>'fence'), 'under 050''s lease and fence');
select public.service_catalog_video_r2_mark_deleted((pg_temp.v('retire')->0->>'copyId')::uuid,'sweeper-test-1',
 (pg_temp.v('retire')->0->>'fence')::bigint,true,null);
select is((select state from private.catalog_video_r2_copies where id=(pg_temp.v('retire')->0->>'copyId')::uuid), 'deleted',
 '050''s own finish closes it');
select is((select state from private.catalog_video_r2_copies where team_id='05758000-0000-4000-8000-0000000000d1'), 'retiring',
 'the Drive copy waits for the 050 sweep, as before');
insert into private.catalog_feed_removals(feed_id,team_ref) values (repeat('1',32),pg_temp.team()),
 (repeat('2',32),'05758000-0000-4000-8000-0000000000d1');
insert into seen select 'feeds', public.service_space_catalog_claim_feed_removals('sweeper-test-1', 30);
select is((select array_agg(c->>'feedId') from jsonb_array_elements(pg_temp.v('feeds')) c), array[repeat('1',32)],
 'an R2 space''s feed removal is claimed; a Drive space''s is left to 050');

-- 9. A variation still running when it leaves ----------------------------------------
insert into seen select 'runop', to_jsonb(op.operation_id) from public.service_start_team_operation(pg_temp.team(), pg_temp.owner(), 'process',
  'purge-run-1','request:purge-run-1',(pg_temp.v('video')#>>'{}')::uuid,pg_temp.root(),'clip restitched.mp4',now()+interval '30 minutes',400) op;
select public.service_set_team_operation_intent((pg_temp.v('runop')#>>'{}')::uuid, pg_temp.owner(), 'Clip restitched.mp4', 'video/mp4', null, null, null, 'restitch', 2);
select public.service_transition_team_operation((pg_temp.v('runop')#>>'{}')::uuid,'running','awaiting_agent',0,null,null,false);
insert into private.space_catalog_variant_sets(id,team_id,actor_id,source_material_id,source_content_id,settings,settings_digest,variant_count,state)
values ('05758000-0000-4000-8000-0000000000e1',pg_temp.team(),pg_temp.owner(),(pg_temp.v('video')#>>'{}')::uuid,repeat('f',64),'{}',repeat('d',64),1,'preparing');
insert into private.space_catalog_variants(set_id,ordinal,request_id,team_id,attempt,operation_id)
values ('05758000-0000-4000-8000-0000000000e1',0,gen_random_uuid(),pg_temp.team(),1,(pg_temp.v('runop')#>>'{}')::uuid);
delete from private.space_catalog_variant_sets where id='05758000-0000-4000-8000-0000000000e1';
select is((select state from public.team_operations where id=(pg_temp.v('runop')#>>'{}')::uuid), 'canceled',
 'a variation that leaves with its set (its catalog deleted for good, or the set abandoned) cancels its run');
select throws_ok(format($$select public.service_finalize_space_process_output('%s', '%s', gen_random_uuid())$$,
 pg_temp.v('runop')#>>'{}', pg_temp.owner()), 'WRONG_STATE', 'its result is never attached');

-- 10. A deleted space -------------------------------------------------------------------------------
insert into seen select 'space2', public.service_create_r2_space(pg_temp.owner(),'Gone space','purge-space-key-0002');
delete from public.teams where id=(pg_temp.v('space2')->>'teamId')::uuid;
select is((select count(*)::integer from private.space_storage_removed_spaces where team_ref=(pg_temp.v('space2')->>'teamId')::uuid), 1,
 'a deleted R2 space leaves a tombstone for its bytes');
delete from public.teams where id='05758000-0000-4000-8000-0000000000d1';
select is((select count(*)::integer from private.space_storage_removed_spaces where team_ref='05758000-0000-4000-8000-0000000000d1'), 0,
 'a deleted Drive space does not');
insert into seen select 'gone', public.service_claim_space_removed_space('sweeper-test-1');
select is(pg_temp.v('gone')->>'teamId', pg_temp.v('space2')->>'teamId', 'the sweeper is handed the space to empty');
select public.service_finish_space_removed_space((pg_temp.v('gone')->>'teamId')::uuid,(pg_temp.v('gone')->>'fence')::bigint, 4, false, null);
select is((select finished_at is null and deleted_objects=4 from private.space_storage_removed_spaces where team_ref=(pg_temp.v('space2')->>'teamId')::uuid),
 true, 'a pass that still found objects keeps it open');
insert into seen select 'gone2', public.service_claim_space_removed_space('sweeper-test-1');
select public.service_finish_space_removed_space((pg_temp.v('gone2')->>'teamId')::uuid,(pg_temp.v('gone2')->>'fence')::bigint, 0, true, null);
select ok((select finished_at is not null from private.space_storage_removed_spaces where team_ref=(pg_temp.v('space2')->>'teamId')::uuid),
 'an empty listing closes it: nothing is left');
select is((select count(*)::integer from public.space_storage_usage where team_id=(pg_temp.v('space2')->>'teamId')::uuid), 0,
 'and its ledger holds 0 bytes');

-- 11. The CLI's projection (T061) ----------------------------------------------------------------
select is((select space_state||':'||purges_failed||':'||(reconciliation_state)||':'||(missing_objects>=2)
  from public.analytics_space_storage where team_id=pg_temp.team()), 'live:0:done:true',
 'the projection shows the space''s queue and its last reconciliation');
select is((select space_state||':'||removed_deleted_objects from public.analytics_space_storage
  where team_id=(pg_temp.v('space2')->>'teamId')::uuid), 'deleted:4', 'and a deleted space by its tombstone');
select ok(not has_table_privilege('authenticated','public.analytics_space_storage','select'), 'never to a signed-in person');

-- 12. Guards ------------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated','public.service_claim_space_object_purges(text,integer)','execute'),
 'the sweeper''s RPCs are not for a signed-in person');
select ok(has_function_privilege('service_role','public.service_space_reconcile_page(uuid,bigint,jsonb,integer,boolean)','execute'),
 'they are for the service');
select is(private.invoke_space_storage_sweeper('sweep'), null, 'without the vault entry nothing is called');
select ok(not exists(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='private' and c.relname='space_storage_removed_spaces' and t.tgname='task_cleanup_reference_fence')
  and not exists(select 1 from private.task_cleanup_reference_tables() where table_name='space_storage_removed_spaces'),
 'the tombstone is outside the cleanup fence inventory (no FK, no json, no fenced name)');

select * from finish();
rollback;
