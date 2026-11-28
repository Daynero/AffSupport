begin;
select plan(14);

-- 057 T110 (20261226280000): a public copy of a catalog video (050) in an R2 space counts against
-- the space's own ledger, the one limit of the space (FR-045, FR-047, FR-050), and never against
-- the legacy catalog-video copy quota (catalog_video_r2_config.team_quota_bytes). A planned copy
-- reserves its bytes; a ready one counts once under `catalogs`; a failed or deleted one gives them
-- back. A copy that does not fit is refused with STORAGE_QUOTA_EXCEEDED before any row. A Drive
-- space keeps the legacy quota exactly as before.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05791100-0000-4000-8000-000000000001','authenticated','authenticated','copy-owner@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values ('05791100-0000-4000-8000-000000000001',2000);

create temporary table seen(label text, value jsonb);
create function pg_temp.team() returns uuid language sql as $$ select (value->>'teamId')::uuid from seen where label='space' $$;
create function pg_temp.root() returns uuid language sql as $$ select (value->>'rootMaterialId')::uuid from seen where label='space' $$;
create function pg_temp.v(p_label text) returns jsonb language sql as $$ select value from seen where label=p_label order by ctid desc limit 1 $$;
create function pg_temp.owner() returns uuid language sql as $$ select '05791100-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.id(p_label text) returns uuid language sql as $$ select (pg_temp.v(p_label)->>'id')::uuid $$;
create function pg_temp.upload(p_key text, p_content text, p_bytes bigint, p_name text)
returns jsonb language plpgsql as $$
declare v_session jsonb; v_upload uuid;
begin
  v_session := public.service_admit_space_upload(pg_temp.owner(), jsonb_build_object(
    'teamId', pg_temp.team(), 'parentMaterialId', pg_temp.root(), 'name', p_name,
    'contentType', 'video/mp4', 'bytes', p_bytes::text, 'contentId', p_content, 'sha256', null,
    'ingress', 'explorer', 'idempotencyKey', p_key,
    'category', 'video', 'classificationSource', 'mime', 'fileExtension', 'mp4'));
  v_upload := (v_session->>'uploadId')::uuid;
  perform public.service_attach_space_upload(v_upload, pg_temp.owner(), 'r2-upload-' || v_upload::text);
  perform public.service_mark_space_upload_completing(v_upload, pg_temp.team(), pg_temp.owner(), p_content, repeat('e',32)||'-1');
  return public.service_complete_space_upload(v_upload, pg_temp.team(), pg_temp.owner(),
    jsonb_build_object('category','video','classificationSource','mime','fileExtension','mp4'))
    || jsonb_build_object('uploadId', v_upload);
end $$;
create function pg_temp.catalogs() returns bigint language sql as $$
  select coalesce((select bytes from public.space_storage_usage where team_id = pg_temp.team() and category = 'catalogs'), 0) $$;
create function pg_temp.reserved() returns bigint language sql as $$ select private.space_reserved_bytes(pg_temp.team()) $$;
create function pg_temp.copy(p_label text) returns private.catalog_video_r2_copies language sql as $$
  select * from private.catalog_video_r2_copies where id = (pg_temp.v(p_label)->>'copyId')::uuid $$;

insert into seen select 'space', public.service_create_r2_space(pg_temp.owner(),'Copy space','copy-space-key-0001');
insert into seen select 'clip', pg_temp.upload('copy-clip-key-00001', repeat('a',64), 400, 'Clip.mp4');
insert into seen select 'big', pg_temp.upload('copy-big-key-000001', repeat('b',64), 1200, 'Big.mp4');
-- The legacy quota is far below what the space allows: an R2 copy must not be held to it.
update private.catalog_video_r2_config set enabled=true, public_origin='https://videos.test', policy_confirmed_at=now(), team_quota_bytes=100;

-- 1. Planning reserves, against the space -----------------------------------------------------
insert into seen select 'link', public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), pg_temp.id('clip'));
select is(pg_temp.v('link')->>'state', 'planned', 'a copy bigger than the legacy quota is planned in an R2 space');
select is(pg_temp.reserved(), 400::bigint, 'the planned copy reserves its bytes in the space');
select is(pg_temp.catalogs(), 0::bigint, 'nothing is counted under catalogs before it is ready');
select throws_ok($$select public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), pg_temp.id('big'))$$,
 'STORAGE_QUOTA_EXCEEDED', 'a copy that does not fit in the space is refused by the space''s own limit');
select is((select count(*) from private.catalog_video_r2_copies where source_material_id = pg_temp.id('big')), 0::bigint,
 'and no copy row is planned for it');

-- 2. Ready counts once under catalogs --------------------------------------------------------
update private.catalog_video_r2_copies set state='ready', ready_at=now() where id=(pg_temp.v('link')->>'copyId')::uuid;
select is(pg_temp.catalogs(), 400::bigint, 'a ready copy counts under catalogs');
select is(pg_temp.reserved(), 0::bigint, 'its reservation is settled');
select is(public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), pg_temp.id('clip'))->>'copyId',
 pg_temp.v('link')->>'copyId', 'a second catalog of the same video uses the same copy');
select is(pg_temp.catalogs(), 400::bigint, 'counted once, however many catalogs use it');
update private.catalog_video_r2_copies set state='retiring' where id=(pg_temp.v('link')->>'copyId')::uuid;
update private.catalog_video_r2_copies set state='ready' where id=(pg_temp.v('link')->>'copyId')::uuid;
select is(pg_temp.catalogs(), 400::bigint, 'retiring and back changes nothing');

-- 3. Gone gives the bytes back ---------------------------------------------------------------
update private.catalog_video_r2_copies set state='deleted', deleted_at=now() where id=(pg_temp.v('link')->>'copyId')::uuid;
select is(pg_temp.catalogs(), 0::bigint, 'a deleted copy leaves the ledger');
insert into seen select 'link2', public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), pg_temp.id('clip'));
update private.catalog_video_r2_copies set state='failed', last_error='VIDEO_R2_TIMEOUT' where id=(pg_temp.v('link2')->>'copyId')::uuid;
select is(pg_temp.reserved(), 0::bigint, 'a failed copy releases its reservation');
insert into seen select 'link3', public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), pg_temp.id('clip'));
delete from private.catalog_video_r2_copies where id=(pg_temp.v('link3')->>'copyId')::uuid;
select is(pg_temp.reserved(), 0::bigint, 'a deleted row releases its reservation');

-- 4. A Drive space keeps the legacy quota ------------------------------------------------------
select ok(strpos(pg_get_functiondef('public.service_catalog_video_r2_resolve(uuid,uuid,text,bigint,text,text,uuid,uuid,boolean)'::regprocedure),
 'when not private.space_is_r2(pref.team_id) and private.catalog_video_r2_team_used_bytes(pref.team_id)+p_size_bytes>cfg.team_quota_bytes then ''VIDEO_R2_QUOTA_EXCEEDED''') > 0,
 'a Drive space''s copy is held to the legacy quota as before');

select * from finish();
rollback;
