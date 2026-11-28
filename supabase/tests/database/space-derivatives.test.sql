begin;
select plan(44);

-- 057 T046: derivatives of an R2 space (20261226350000). The browser declares what it made and
-- the edge function tells the commit which ones it checked; the commit records them, the media
-- facts and the preview state, and opens an agent job for what is missing. A member's agent
-- claims a job with a lease, finishes it, and the folder hears it.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05746000-0000-4000-8000-000000000001','authenticated','authenticated','owner46@test.invalid','{}','{}'),
 ('05746000-0000-4000-8000-000000000002','authenticated','authenticated','editor46@test.invalid','{}','{}'),
 ('05746000-0000-4000-8000-000000000003','authenticated','authenticated','stranger46@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values
 ('05746000-0000-4000-8000-000000000001',100000),
 ('05746000-0000-4000-8000-000000000002',100000),
 ('05746000-0000-4000-8000-000000000003',100000);

create temporary table seen(label text, value jsonb);
create function pg_temp.team() returns uuid language sql as $$ select (value->>'teamId')::uuid from seen where label='space' $$;
create function pg_temp.root() returns uuid language sql as $$ select (value->>'rootMaterialId')::uuid from seen where label='space' $$;
create function pg_temp.editor() returns uuid language sql as $$ select '05746000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.cid(p text) returns text language sql as $$ select repeat(p,64) $$;
create function pg_temp.upload(p_label text) returns uuid language sql as $$ select (value->>'uploadId')::uuid from seen where label=p_label $$;
create function pg_temp.lease(p text) returns text language sql as $$ select repeat(p,64) $$;
-- An admitted, multipart-attached session (the edge function's part of admit).
create function pg_temp.admit(p_key text, p_content text, p_name text, p_type text, p_category text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  v := public.service_admit_space_upload(pg_temp.editor(), jsonb_build_object(
    'teamId', pg_temp.team(), 'parentMaterialId', pg_temp.root(), 'name', p_name,
    'contentType', p_type, 'bytes', '100', 'contentId', p_content, 'ingress', 'explorer',
    'idempotencyKey', p_key, 'category', p_category, 'classificationSource', 'mime'));
  if v->>'kind' = 'session' then
    perform public.service_attach_space_upload((v->>'uploadId')::uuid, pg_temp.editor(), 'r2-' || p_key);
  end if;
  return v;
end $$;
create function pg_temp.pic(p_variant text, p_edge integer default 100) returns jsonb language sql as $$
  select jsonb_build_object('variant', p_variant, 'contentType', 'image/webp', 'bytes', 1000,
    'width', p_edge, 'height', p_edge * 3 / 4, 'md5', repeat('d', 32))
$$;
-- Stands for the edge function's complete: parts verified, derivatives checked as given.
create function pg_temp.complete(p_upload uuid, p_content text, p_category text, p_checked jsonb) returns jsonb language plpgsql as $$
begin
  perform public.service_mark_space_upload_completing(p_upload, pg_temp.team(), pg_temp.editor(), p_content, repeat('e',32)||'-1');
  return public.service_complete_space_upload(p_upload, pg_temp.team(), pg_temp.editor(),
    jsonb_build_object('category', p_category, 'classificationSource', 'mime', 'derivatives', p_checked));
end $$;
create function pg_temp.object_of(p_content text) returns uuid language sql as $$
  select id from public.space_objects where team_id = pg_temp.team() and content_id = p_content and kind = 'original'
$$;
create function pg_temp.preview(p_content text) returns text language sql as $$
  select string_agg(distinct material.provider_thumbnail_state || coalesce(':' || material.provider_thumbnail_reason, ''), ',')
    from public.team_materials material where material.space_object_id = pg_temp.object_of(p_content)
$$;
create function pg_temp.job(p_content text) returns text language sql as $$
  select state || ':' || reason from public.space_derivative_jobs where object_id = pg_temp.object_of(p_content)
$$;

insert into seen select 'space', public.service_create_r2_space('05746000-0000-4000-8000-000000000001','Derivative space','derivative-space-0001');
insert into public.team_members(team_id,user_id,base_role) values
 (pg_temp.team(),'05746000-0000-4000-8000-000000000002','editor');

-- 1. The browser declares its pictures --------------------------------------------------------
insert into seen select 'img', pg_temp.admit('image-key-000000001', pg_temp.cid('a'), 'Photo.jpg', 'image/jpeg', 'image');
select is(
  (select jsonb_agg(item->>'stagingKey' order by item->>'variant') from jsonb_array_elements(
    public.service_declare_space_upload_derivatives(pg_temp.upload('img'), pg_temp.team(), pg_temp.editor(),
      jsonb_build_object('category','image','derivatives', jsonb_build_array(pg_temp.pic('row'), pg_temp.pic('tile', 400), pg_temp.pic('full', 1200)),
        'media', jsonb_build_object('width', 4000, 'height', 3000)))) as item),
  jsonb_build_array(
    't/'||pg_temp.team()||'/u/'||pg_temp.upload('img')||'/full',
    't/'||pg_temp.team()||'/u/'||pg_temp.upload('img')||'/row',
    't/'||pg_temp.team()||'/u/'||pg_temp.upload('img')||'/tile'),
  'each declared picture gets its staging key under the upload');
select throws_ok($$select public.service_declare_space_upload_derivatives(pg_temp.upload('img'), pg_temp.team(), pg_temp.editor(),
  jsonb_build_object('category','image','derivatives', jsonb_build_array(pg_temp.pic('poster'))))$$,
  '22023','INVALID_INPUT','a picture has no poster');
select throws_ok($$select public.service_declare_space_upload_derivatives(pg_temp.upload('img'), pg_temp.team(), pg_temp.editor(),
  jsonb_build_object('category','image','derivatives', jsonb_build_array(pg_temp.pic('tile', 481))))$$,
  '22023','INVALID_INPUT','a tile larger than its bounds is refused');
select throws_ok($$select public.service_declare_space_upload_derivatives(pg_temp.upload('img'), pg_temp.team(), pg_temp.editor(),
  jsonb_build_object('category','image','derivatives', jsonb_build_array(pg_temp.pic('row') - 'md5')))$$,
  '22023','INVALID_INPUT','a picture without its MD5 cannot be signed');
select is((select count(*)::integer from public.space_upload_derivatives where upload_id = pg_temp.upload('img')), 3,
  'a refused declaration leaves the last good one');
select throws_ok($$select public.service_declare_space_upload_derivatives(pg_temp.upload('img'), pg_temp.team(),
  '05746000-0000-4000-8000-000000000003', '{}'::jsonb)$$,
  '42501','PERMISSION_DENIED','a stranger declares nothing');

-- 2. The commit records what was checked -------------------------------------------------------
insert into seen select 'img-c', pg_temp.complete(pg_temp.upload('img'), pg_temp.cid('a'), 'image', jsonb_build_array(
  pg_temp.pic('row') - 'md5' || '{"accepted":true}', pg_temp.pic('tile', 400) - 'md5' || '{"accepted":true}',
  pg_temp.pic('full', 1200) - 'md5' || '{"accepted":true}'));
select is((select count(*)::integer from public.space_objects where derivative_of = pg_temp.object_of(pg_temp.cid('a')) and state = 'committed'),
  3, 'three derivative objects of the original');
select is((select r2_key from public.space_objects where derivative_of = pg_temp.object_of(pg_temp.cid('a')) and variant = 'tile'),
  't/'||pg_temp.team()||'/d/'||pg_temp.cid('a')||'/1/tile', 'a derivative lives under the content key');
select is((select coalesce(sum(bytes),0)::bigint from public.space_storage_usage where team_id = pg_temp.team()), 100::bigint,
  'derivatives are not counted in the space');
select is(pg_temp.preview(pg_temp.cid('a')), 'ready', 'the picture is ready at once');
select is((select value->>'thumbnailReady' from seen where label='img-c'), 'true', 'the commit says so');
select is((select provider_thumbnail_version from public.team_materials where id = (select (value->>'id')::uuid from seen where label='img-c')),
  'r2:1', 'with the recipe as its version');
select is(pg_temp.job(pg_temp.cid('a')), null, 'nothing is left for an agent');
select is((select width||'x'||height from public.space_objects where id = pg_temp.object_of(pg_temp.cid('a'))), '4000x3000',
  'the browser''s size is the original''s');
select is((select string_agg(state, ',' order by variant) from public.space_upload_derivatives where upload_id = pg_temp.upload('img')),
  'accepted,accepted,accepted', 'the declarations are settled');

-- 3. What is missing becomes an agent job -------------------------------------------------------
insert into seen select 'vid', pg_temp.admit('video-key-000000001', pg_temp.cid('b'), 'Clip.mp4', 'video/mp4', 'video');
select is(jsonb_array_length(public.service_declare_space_upload_derivatives(pg_temp.upload('vid'), pg_temp.team(), pg_temp.editor(),
  jsonb_build_object('category','video','derivatives', jsonb_build_array(pg_temp.pic('tile', 400), pg_temp.pic('poster', 1280), pg_temp.pic('sprite', 1600)),
  'media', jsonb_build_object('durationMs', 12000, 'width', 1080, 'height', 1920)))), 3, 'a video declares its poster and hover frames');
do $$ begin perform pg_temp.complete(pg_temp.upload('vid'), pg_temp.cid('b'), 'video', jsonb_build_array(
  pg_temp.pic('tile', 400) - 'md5' || '{"accepted":true}', pg_temp.pic('poster', 1280) - 'md5' || '{"accepted":true}',
  pg_temp.pic('sprite', 1600) - 'md5' || '{"accepted":false,"reason":"dimensions"}')); end $$;
select is(pg_temp.preview(pg_temp.cid('b')), 'ready', 'a video with its tile shows it');
select is(pg_temp.job(pg_temp.cid('b')), 'pending_agent:missing_media_facts', 'its codec and frame rate wait for an agent');
select is((select reject_reason from public.space_upload_derivatives where upload_id = pg_temp.upload('vid') and variant = 'sprite'),
  'dimensions', 'the refused picture says why');
select is((select duration_ms from public.space_objects where id = pg_temp.object_of(pg_temp.cid('b'))), 12000::bigint,
  'the browser''s duration is kept');

insert into seen select 'rej', pg_temp.admit('reject-key-00000001', pg_temp.cid('c'), 'Other.mp4', 'video/mp4', 'video');
do $$ begin perform public.service_declare_space_upload_derivatives(pg_temp.upload('rej'), pg_temp.team(), pg_temp.editor(),
  jsonb_build_object('category','video','derivatives', jsonb_build_array(pg_temp.pic('tile', 400)))); end $$;
do $$ begin perform pg_temp.complete(pg_temp.upload('rej'), pg_temp.cid('c'), 'video', jsonb_build_array(
  pg_temp.pic('tile', 400) - 'md5' || '{"accepted":false,"reason":"type"}')); end $$;
select is(pg_temp.preview(pg_temp.cid('c')), 'pending', 'a refused tile: the preview is on its way');
select is(pg_temp.job(pg_temp.cid('c')), 'pending_agent:client_skipped', 'and an agent will make it');

insert into seen select 'hevc', pg_temp.admit('hevc-key-000000001', pg_temp.cid('d'), 'Phone.mov', 'video/quicktime', 'video');
do $$ begin perform public.service_declare_space_upload_derivatives(pg_temp.upload('hevc'), pg_temp.team(), pg_temp.editor(),
  jsonb_build_object('category','video','derivatives','[]'::jsonb,'unsupported',true)); end $$;
do $$ begin perform pg_temp.complete(pg_temp.upload('hevc'), pg_temp.cid('d'), 'video', '[]'::jsonb); end $$;
select is(pg_temp.job(pg_temp.cid('d')), 'pending_agent:browser_unsupported', 'what the browser cannot read is the agent''s');

insert into seen select 'pdf', pg_temp.admit('pdf-key-0000000001', pg_temp.cid('5'), 'Brief.pdf', 'application/pdf', 'other');
do $$ begin perform pg_temp.complete(pg_temp.upload('pdf'), pg_temp.cid('5'), 'other', '[]'::jsonb); end $$;
select is(pg_temp.job(pg_temp.cid('5'))||'|'||pg_temp.preview(pg_temp.cid('5')), 'pending_agent:browser_unsupported|pending',
  'a PDF waits for an agent');

insert into seen select 'zip', pg_temp.admit('zip-key-0000000001', pg_temp.cid('6'), 'Pack.zip', 'application/zip', 'archive');
do $$ begin perform pg_temp.complete(pg_temp.upload('zip'), pg_temp.cid('6'), 'archive', '[]'::jsonb); end $$;
select is(pg_temp.job(pg_temp.cid('6'))||'|'||pg_temp.preview(pg_temp.cid('6')), null, 'an archive has no picture and no job');
select is(pg_temp.preview(pg_temp.cid('6')), 'not_applicable', 'and says so');

-- The same picture linked in another folder is ready at once.
insert into seen select 'sub', public.service_mutate_space_materials(pg_temp.editor(), pg_temp.team(),
  jsonb_build_object('action','create_folder','parentMaterialId',pg_temp.root(),'name','Sub'));
select is((public.service_admit_space_upload(pg_temp.editor(), jsonb_build_object(
    'teamId', pg_temp.team(), 'parentMaterialId', (select (value->'materials'->0->>'id') from seen where label='sub'), 'name', 'Copy.jpg',
    'contentType', 'image/jpeg', 'bytes', '100', 'contentId', pg_temp.cid('a'), 'ingress', 'explorer',
    'idempotencyKey', 'link-key-000000001', 'category', 'image')))->>'kind', 'exists', 'the same content is linked');
select is(pg_temp.preview(pg_temp.cid('a')), 'ready', 'its link has the picture too');

-- 4. An agent claims, with a lease -----------------------------------------------------------------
-- One transaction stamps every job alike; the clip is made the older of the two unreadable ones.
update public.space_derivative_jobs set created_at = now() + interval '1 second'
 where object_id = pg_temp.object_of(pg_temp.cid('5'));
select throws_ok($$select public.service_claim_space_derivative_jobs(pg_temp.team(), '05746000-0000-4000-8000-000000000003', pg_temp.lease('1'))$$,
  '42501','PERMISSION_DENIED','a stranger claims nothing');
insert into seen select 'claim1', public.service_claim_space_derivative_jobs(pg_temp.team(), pg_temp.editor(), pg_temp.lease('1'));
select is((select value->'jobs'->0->>'reason' from seen where label='claim1'), 'browser_unsupported',
  'what the browser could not read goes first');
select is((select state||':'||attempts from public.space_derivative_jobs where object_id = (select (value->'jobs'->0->>'objectId')::uuid from seen where label='claim1')),
  'claimed:1', 'the job is leased, attempt one');
select throws_ok(format($$select public.service_finish_space_derivative(%L, %L, %L, '{"outcome":"ready"}'::jsonb)$$,
  pg_temp.team(), (select value->'jobs'->0->>'objectId' from seen where label='claim1'), pg_temp.lease('2')),
  '42501','AUTH_REQUIRED','another lease cannot finish it');
select is((public.service_space_derivative_lease(pg_temp.team(), (select (value->'jobs'->0->>'objectId')::uuid from seen where label='claim1'), pg_temp.lease('1')))->>'claimId',
  (select value->'jobs'->0->>'claimId' from seen where label='claim1'), 'the lease names its claim');

-- Finishing: ready, with the agent's facts.
delete from public.team_space_storage_signals where team_id = pg_temp.team();
select is((public.service_finish_space_derivative(pg_temp.team(), (select (value->'jobs'->0->>'objectId')::uuid from seen where label='claim1'), pg_temp.lease('1'),
  jsonb_build_object('outcome','ready','derivatives', jsonb_build_array(pg_temp.pic('tile', 400) - 'md5', pg_temp.pic('poster', 1280) - 'md5'),
    'media', jsonb_build_object('durationMs', 5000, 'codec', 'hevc', 'fps', 29.97))))->>'state', 'ready', 'the agent''s pictures are in');
select is(pg_temp.preview(pg_temp.cid('d')), 'ready', 'the HEVC clip shows its picture');
select is((select codec||'@'||fps from public.space_objects where id = pg_temp.object_of(pg_temp.cid('d'))), 'hevc@29.970', 'with its codec and frame rate');
select is((select count(*)::integer from public.team_space_storage_signals where team_id = pg_temp.team() and kind = 'derivative' and folder_id = pg_temp.root()),
  1, 'the folder hears it');

-- Unsupported: the file says no picture will come.
insert into seen select 'claim2', public.service_claim_space_derivative_jobs(pg_temp.team(), pg_temp.editor(), pg_temp.lease('3'));
select is((select value->'jobs'->0->>'name' from seen where label='claim2'), 'Brief.pdf', 'then the PDF');
do $$ begin perform public.service_finish_space_derivative(pg_temp.team(), (select (value->'jobs'->0->>'objectId')::uuid from seen where label='claim2'),
  pg_temp.lease('3'), '{"outcome":"unsupported","errorCode":"UNSUPPORTED_FORMAT"}'::jsonb); end $$;
select is(pg_temp.preview(pg_temp.cid('5')), 'unavailable:unsupported', 'a PDF with no renderer says so');

-- A failed attempt and an expired lease return the job; the third one ends it.
insert into seen select 'claim3', public.service_claim_space_derivative_jobs(pg_temp.team(), pg_temp.editor(), pg_temp.lease('4'));
select is((public.service_finish_space_derivative(pg_temp.team(), (select (value->'jobs'->0->>'objectId')::uuid from seen where label='claim3'),
  pg_temp.lease('4'), '{"outcome":"failed","errorCode":"SOURCE_UNAVAILABLE"}'::jsonb))->>'state', 'pending_agent', 'a failed attempt is tried again');
update public.space_derivative_jobs set attempts = 2 where object_id = (select (value->'jobs'->0->>'objectId')::uuid from seen where label='claim3');
insert into seen select 'claim4', public.service_claim_space_derivative_jobs(pg_temp.team(), pg_temp.editor(), pg_temp.lease('5'));
select is((select value->'jobs'->0->>'objectId' from seen where label='claim4'), (select value->'jobs'->0->>'objectId' from seen where label='claim3'),
  'the same job comes back');
update public.space_derivative_jobs set lease_until = now() - interval '1 second'
 where object_id = (select (value->'jobs'->0->>'objectId')::uuid from seen where label='claim4');
select throws_ok(format($$select public.service_space_derivative_lease(%L, %L, %L)$$, pg_temp.team(),
  (select value->'jobs'->0->>'objectId' from seen where label='claim4'), pg_temp.lease('5')),
  '55000','UPLOAD_EXPIRED','an expired lease stages nothing');
do $$ begin perform public.service_claim_space_derivative_jobs(pg_temp.team(), pg_temp.editor(), pg_temp.lease('6')); end $$;
select is((select state from public.space_derivative_jobs where object_id = (select (value->'jobs'->0->>'objectId')::uuid from seen where label='claim4')),
  'failed', 'the third attempt that ran out ends the job');
select is(pg_temp.preview((select content_id from public.space_objects where id = (select (value->'jobs'->0->>'objectId')::uuid from seen where label='claim4'))),
  'unavailable:corrupt', 'and the file says its picture could not be made');

select * from finish();
rollback;
