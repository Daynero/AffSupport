begin;
select plan(36);

-- 057 T114 (20261226320000): a re-stitched Launch catalog in an R2 space — one video, or one
-- variation set per video creative — accepted, waited for, linked, attached and canceled over the
-- space's own sets; a Drive space answers as before.
--
-- The Launch's inner admission (service_accept_launch_generation_before_video: the draft, the
-- version CAS, the generation row) and the frozen resources are stubbed in this transaction: what
-- is tested is the video acceptance around them, which is what 20261226320000 patches.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05791050-0000-4000-8000-000000000001','authenticated','authenticated','launch-variants-owner@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values ('05791050-0000-4000-8000-000000000001',50000000);
insert into public.teams(id,name,owner_id,storage_backend,storage_pilot) values
 ('05791050-0000-4000-8000-000000000011','Launch variants R2','05791050-0000-4000-8000-000000000001','r2',true);
insert into public.team_members(team_id,user_id,base_role) values
 ('05791050-0000-4000-8000-000000000011','05791050-0000-4000-8000-000000000001','admin')
 on conflict do nothing;
insert into public.team_materials(id,team_id,name,kind) values
 ('05791050-0000-4000-8000-000000000101','05791050-0000-4000-8000-000000000011','Launch variants R2','folder');
update public.teams set storage_root_material_id='05791050-0000-4000-8000-000000000101'
 where id='05791050-0000-4000-8000-000000000011';
insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key,state)
select ('05791050-0000-4000-8000-0000000002'||lpad(n::text,2,'0'))::uuid,'05791050-0000-4000-8000-000000000011',repeat(n::text,64),
  1000*n,'video/mp4','t/05791050-0000-4000-8000-000000000011/o/'||repeat(n::text,64),'committed'
from generate_series(1,6) n;
-- 1..3 are the creatives, 4..6 the variations' outputs.
insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,mime_type,space_object_id,size_bytes)
select ('05791050-0000-4000-8000-0000000001'||lpad((10+n)::text,2,'0'))::uuid,'05791050-0000-4000-8000-000000000011',
  '05791050-0000-4000-8000-000000000101','video-'||n||'.mp4','file','video','video/mp4',
  ('05791050-0000-4000-8000-0000000002'||lpad(n::text,2,'0'))::uuid,1000*n
from generate_series(1,6) n;
update private.catalog_video_r2_config set enabled=true, public_origin='https://videos.test', policy_confirmed_at=now();
insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash) values
 ('05791050-0000-4000-8000-000000000011','05791050-0000-4000-8000-000000000001','05791050-0000-4000-8000-000000000901',sha256('launch-variants'::bytea));

create temporary table seen(label text, value jsonb);
create function pg_temp.v(p_label text) returns jsonb language sql as $$ select value from seen where label=p_label order by ctid desc limit 1 $$;
create function pg_temp.team() returns uuid language sql as $$ select '05791050-0000-4000-8000-000000000011'::uuid $$;
create function pg_temp.owner() returns uuid language sql as $$ select '05791050-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.video(n int) returns uuid language sql as $$ select ('05791050-0000-4000-8000-0000000001'||lpad((10+n)::text,2,'0'))::uuid $$;
create function pg_temp.id(p_kind int, n int) returns uuid language sql as $$ select ('05791050-0000-4000-8000-00000000'||p_kind::text||lpad(n::text,3,'0'))::uuid $$;

-- The stubs: the Launch's own admission answers the generation this test made for the key.
create or replace function public.service_accept_launch_generation_before_video(p_team uuid,p_launch uuid,p_actor uuid,p_expected_version text,p_key text,p_digest text,p_config jsonb,p_sources jsonb,p_preview jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('id',g.id,'fence',g.fence::text) from public.team_launch_generations g where g.team_id=p_team and g.request_key=p_key $$;
create or replace function private.freeze_launch_catalog_resources(p_team uuid,p_generation uuid,p_actor uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;

-- A Launch and its generation n, made by hand.
create function pg_temp.generation(n int, p_count int default 2) returns uuid language plpgsql as $$
begin
  insert into public.team_launches(id,team_id,created_by,draft_config) values (pg_temp.id(3,n),pg_temp.team(),pg_temp.owner(),'{}');
  insert into public.team_launch_revisions(id,team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)
  values (pg_temp.id(4,n),pg_temp.team(),pg_temp.id(3,n),1,'generated',jsonb_build_object('catalog',jsonb_build_object('productCount',p_count)),'{"materialType":"video"}','https://offer.test/','https://offer.test/?s=1','{}',pg_temp.owner());
  insert into public.team_launch_generations(id,team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state)
  values (pg_temp.id(5,n),pg_temp.team(),pg_temp.id(3,n),pg_temp.id(4,n),pg_temp.owner(),'launch-key-'||n,'digest','v1','accepted');
  return pg_temp.id(5,n);
end $$;
create function pg_temp.duration() returns jsonb language sql as $$ select '{"finalDurationMode":"custom","customFinalDurationSeconds":2700}'::jsonb $$;
create function pg_temp.settings() returns jsonb language sql as $$
  select private.effective_restitch_defaults_json(pg_temp.team(),pg_temp.owner())||pg_temp.duration() $$;
-- The Launch's config and its video admission: k creatives (videos 1..k), `variants` variations.
create function pg_temp.config(k int, variants int, n int) returns jsonb language sql as $$
  select jsonb_build_object('method','catalog','materialId',pg_temp.video(1),
    'catalog',jsonb_build_object('productCount',n,'restitchEnabled',true,'catalogVideoProtocolVersion',1,
      'videoVariationCount',variants,'videoPublication',jsonb_build_object('mode','immediate'),
      'finalDurationMode','custom','customFinalDurationSeconds',2700))
  || case when k > 1 then jsonb_build_object('creativeKind','video','creatives',
       (select jsonb_agg(jsonb_build_object('materialId',pg_temp.video(o),'alias','c'||o,'copies',2) order by o) from generate_series(1,k) o))
     else '{}'::jsonb end $$;
-- Generation g: rows id(6, 10g+r), requests id(7, 10g+r), sets id(8, 10g+o); each creative 2 rows.
create function pg_temp.video_admission(g int, k int, variants int, p_preferences jsonb default '{}') returns jsonb language plpgsql as $$
declare n int := 2*k; segs jsonb := '[]'; seed text := repeat('a',64); o int; req int := 0; share int; children jsonb; preferences jsonb;
  segment_assignments jsonb := '[]';
begin
  for o in 0 .. k-1 loop
    share := case when k = 1 then variants else (case when o < variants % k then variants / k + 1 else variants / k end) end;
    children := (select jsonb_agg(pg_temp.id(7,10*g+req+i)) from generate_series(0,share-1) i);
    segs := segs || jsonb_build_array(jsonb_build_object('ordinal',o,'materialId',pg_temp.video(o+1),'alias','c'||(o+1),'kind','video',
      'rowStart',2*o,'rowCount',2,'variantCount',share,'setId',pg_temp.id(8,10*g+o),'childRequestIds',children,
      'assignmentSeed',case when k = 1 then seed else encode(sha256(convert_to(seed||':'||o,'UTF8')),'hex') end));
    segment_assignments := segment_assignments || jsonb_build_array((select jsonb_agg(jsonb_build_object('recipeRowId',pg_temp.id(6,10*g+2*o+r),'videoVariantIndex',r % share)) from generate_series(0,1) r));
    req := req + share;
  end loop;
  preferences := jsonb_build_object('catalogVideoProtocolVersion',1,'restitchEnabled',true,'videoVariationCount',variants,
    'videoPublication',jsonb_build_object('mode','immediate'),'restitchDuration',pg_temp.duration())
    || case when k > 1 then jsonb_build_object('creativeKind','video','creatives',
         (select jsonb_agg(jsonb_build_object('materialId',pg_temp.video(q),'alias','c'||q,'copies',2) order by q) from generate_series(1,k) q)) else '{}'::jsonb end
    || p_preferences;
  return jsonb_build_object(
    'plan',jsonb_build_object('preferences',preferences,'acceptedAt',floor(extract(epoch from clock_timestamp())*1000)::bigint,
      'recipeRevision',1,'assignmentSeed',seed,'setId',pg_temp.id(8,10*g),
      'recipeRowIds',(select jsonb_agg(pg_temp.id(6,10*g+r) order by r) from generate_series(0,n-1) r),
      'childRequestIds',(select jsonb_agg(pg_temp.id(7,10*g+i) order by i) from generate_series(0,variants-1) i))
      || case when k > 1 then jsonb_build_object('segments',segs) else '{}'::jsonb end,
    'executorId',null,'settings',pg_temp.settings(),
    'settingsDigest',encode(sha256(convert_to(private.launch_video_settings_json(pg_temp.settings()),'UTF8')),'hex'),
    'assignments',segment_assignments->0)
    || case when k > 1 then jsonb_build_object('segmentAssignments',segment_assignments) else '{}'::jsonb end;
end $$;
create function pg_temp.accept(g int, k int, variants int, p_preferences jsonb default '{}') returns jsonb language sql as $$
  select public.service_accept_launch_catalog_video_generation(pg_temp.team(),pg_temp.id(3,g),pg_temp.owner(),'1','launch-key-'||g,'digest',
    pg_temp.config(k,variants,2*k),
    jsonb_build_object('materialType','video','restitchSettingsVersion',private.launch_restitch_settings_version(pg_temp.team(),pg_temp.owner())),
    '{"advertisingUrl":"https://offer.test/?s=1"}',pg_temp.video_admission(g,k,variants,p_preferences)) $$;
create function pg_temp.intent(g int) returns uuid language sql as $$
  select catalog_intent_id from private.launch_catalog_video_contexts where generation_id=pg_temp.id(5,g) $$;
create function pg_temp.lease(g int) returns text language sql as $$
  update public.team_launch_generations set state='running',lease_owner='owner-'||g,lease_expires_at=clock_timestamp()+interval '5 minutes'
   where id=pg_temp.id(5,g) returning fence::text $$;
create function pg_temp.wait(g int) returns jsonb language sql as $$
  select public.service_wait_launch_catalog_video(pg_temp.team(),pg_temp.id(5,g),pg_temp.owner(),'owner-'||g,pg_temp.lease(g)) $$;

-- 1. One re-stitched video ------------------------------------------------------------------------
select pg_temp.generation(1);
select lives_ok($$select pg_temp.accept(1,1,2)$$, 'an R2 Launch of one re-stitched video is accepted');
select is((select jsonb_build_object('source',source_material_id,'count',variant_count,'state',state,'intent',catalog_intent_id)
  from private.space_catalog_variant_sets where id=pg_temp.id(8,10)),
  jsonb_build_object('source',pg_temp.video(1),'count',2,'state','preparing','intent',pg_temp.intent(1)),
  'its variations are a set of the space under the Launch''s creation');
select is((select settings-'updatedAt'-'updatedBy'-'builtin' from private.space_catalog_variant_sets where id=pg_temp.id(8,10)),
  pg_temp.settings()-'updatedAt'-'updatedBy'-'builtin', 'frozen with the member''s settings and the Launch''s duration');
select is((select array_agg(request_id order by ordinal) from private.space_catalog_variants where set_id=pg_temp.id(8,10)),
  array[pg_temp.id(7,10),pg_temp.id(7,11)], 'one variation per planned request');
select is((select jsonb_build_object('set',video_set_id,'executor',executor_id) from private.launch_catalog_video_contexts where generation_id=pg_temp.id(5,1)),
  '{"set":null,"executor":null}'::jsonb, 'the frozen context names no Drive set and no executor');
select is((select count(*)::int from private.catalog_video_sets where catalog_intent_id=pg_temp.intent(1)), 0, 'no Drive set is made');
select pg_temp.generation(2);
select throws_ok($$select pg_temp.accept(2,1,2,jsonb_build_object('expectedExecutorId','05791050-0000-4000-8000-000000000901'))$$,
  'INVALID_INPUT', 'an R2 Launch names no executor');
update private.team_recovery_delegations set revoked_at=now() where team_id=pg_temp.team();
select throws_ok($$select pg_temp.accept(2,1,2)$$, 'AGENT_REQUIRED', 'without the member''s background agent nothing is accepted');
update private.team_recovery_delegations set revoked_at=null where team_id=pg_temp.team();

-- 2. Waiting, progress, the background agent ----------------------------------------------------
insert into seen select 'wait1', pg_temp.wait(1);
select is(pg_temp.v('wait1'), '{"state":"preparing","setCount":1}'::jsonb, 'the waiting generation reads its space set');
select is((select state from public.team_launch_generations where id=pg_temp.id(5,1)), 'accepted', 'and waits');
select is(private.launch_space_video_generation_json(pg_temp.team(),pg_temp.id(5,1)) - 'activeChildOperationId' - 'spaceSets',
  jsonb_build_object('setId',pg_temp.id(8,10),'requestedCount',2,'registeredCount',0,'state','preparing'), 'its progress is the set''s');
select set_config('request.jwt.claim.sub',pg_temp.owner()::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.owner(),'role','authenticated')::text,true);
select is(public.get_launch(pg_temp.team(),pg_temp.id(3,1)) #>> '{generation,videoGeneration,setId}', pg_temp.id(8,10)::text,
  'the Launch shows it');
insert into seen select 'claim', public.service_claim_space_catalog_variant(pg_temp.team(),pg_temp.owner(),sha256('lease-1'::bytea),120);
select is(pg_temp.v('claim')->>'setId', pg_temp.id(8,10)::text, 'the member''s background agent takes its next variation');
-- The agent opens the run of variation 0 under its lease (as space-storage does).
insert into seen select 'run', to_jsonb((select operation_id from public.service_start_team_operation(pg_temp.team(),pg_temp.owner(),'process',
  'space-variant:'||(pg_temp.v('claim')->>'requestId')||':1','space-variant:'||(pg_temp.v('claim')->>'requestId')||':1',pg_temp.video(1),
  '05791050-0000-4000-8000-000000000101','variant.mp4',now()+interval '1 hour',null)));
select public.service_bind_space_catalog_variant_job(pg_temp.team(),pg_temp.owner(),(pg_temp.v('claim')->>'jobId')::uuid,sha256('lease-1'::bytea),1,
  (pg_temp.v('run')#>>'{}')::uuid);
update private.space_catalog_variants set attempt=3, job_id=null, lease_hash=null, lease_expires_at=null where set_id=pg_temp.id(8,10) and ordinal=1;
insert into seen select 'wait2', pg_temp.wait(1);
select is(pg_temp.v('wait2')->>'state', 'unknown', 'a variation that failed three times makes the set uncertain');
select is((select state||':'||safe_error_code from public.team_launch_generations where id=pg_temp.id(5,1)), 'interrupted:PROCESS_RESULT_UNCERTAIN',
  'and stops the generation');

-- 3. Several videos: a set per video segment ----------------------------------------------------
select pg_temp.generation(3,4);
select lives_ok($$select pg_temp.accept(3,2,3)$$, 'an R2 Launch of two re-stitched videos is accepted');
select is((select jsonb_agg(jsonb_build_array(source_material_id,variant_count) order by id) from private.space_catalog_variant_sets where catalog_intent_id=pg_temp.intent(3)),
  jsonb_build_array(jsonb_build_array(pg_temp.video(1),2),jsonb_build_array(pg_temp.video(2),1)), 'each video has its own set and share');
select is((select count(*)::int from private.launch_catalog_video_segments where generation_id=pg_temp.id(5,3) and video_set_id is null and kind='video'), 2,
  'the segments are recorded without a Drive set');
select throws_ok($$select public.service_admit_space_catalog_variants(pg_temp.team(),pg_temp.owner(),pg_temp.intent(3),gen_random_uuid(),pg_temp.video(3),array[gen_random_uuid()],pg_temp.settings(),repeat('b',64))$$,
  'WRONG_STATE', 'a video outside the plan is not admitted');
select throws_ok($$select public.service_admit_space_catalog_variants(pg_temp.team(),pg_temp.owner(),pg_temp.intent(3),gen_random_uuid(),pg_temp.video(2),array[pg_temp.id(7,32)],pg_temp.settings(),repeat('b',64))$$,
  'WRONG_STATE', 'a segment admits only its own set');
select is(public.service_admit_space_catalog_variants(pg_temp.team(),pg_temp.owner(),pg_temp.intent(3),pg_temp.id(8,31),pg_temp.video(2),array[pg_temp.id(7,32)],null,null)->>'setId',
  pg_temp.id(8,31)::text, 'admitting a segment again answers its set');
insert into seen select 'wait3', pg_temp.wait(3);
select is(pg_temp.v('wait3'), '{"state":"preparing","setCount":2}'::jsonb, 'waiting sees every set');
select is(jsonb_array_length(private.launch_space_video_generation_json(pg_temp.team(),pg_temp.id(5,3))->'segments'), 2, 'progress lists every segment');
update private.space_catalog_variants set attempt=3 where set_id=pg_temp.id(8,31);
select is(pg_temp.wait(3)->>'failedOrdinal', '1', 'waiting names the creative whose variation failed');
update private.space_catalog_variants set attempt=0 where set_id=pg_temp.id(8,31);

-- 4. The link binds every set; the catalog is attached once all are bound -------------------------
-- Outputs: video 4 and 5 for the first set, video 6 for the second.
update private.space_catalog_variants v set output_material_id=pg_temp.video(4+ordinal) where set_id=pg_temp.id(8,30);
update private.space_catalog_variants v set output_material_id=pg_temp.video(6) where set_id=pg_temp.id(8,31);
select public.service_space_catalog_video_link(pg_temp.team(),pg_temp.owner(),pg_temp.video(n)) from generate_series(4,6) n;
create function pg_temp.feed(p_key text) returns uuid language plpgsql as $$
declare op uuid;
begin
  select operation_id into op from public.service_start_team_operation(pg_temp.team(),pg_temp.owner(),'upload',p_key,p_key,pg_temp.video(1),
    '05791050-0000-4000-8000-000000000101',p_key,now()+interval '1 hour',null);
  return (public.service_commit_space_catalog_feed(op,pg_temp.owner(),p_key,2048)->>'materialId')::uuid;
end $$;
create function pg_temp.record(p_sets jsonb) returns jsonb language sql as $$
  select jsonb_build_object('sourceLink','https://offer.test/?s=1','productCount',4,
    'sheetUrl','https://catalog-videos-beta.soty.pp.ua/feeds/'||repeat('c',32)||'.csv','videoLink','https://videos.test/first',
    'settingsSnapshot',jsonb_build_object('_catalogCreativeKind','video','_catalogRowCreatives','[0,0,1,1]'::jsonb,'_catalogCreatives',jsonb_build_array(
      jsonb_build_object('ordinal',0,'materialId',pg_temp.video(1),'alias','c1','kind','video'),
      jsonb_build_object('ordinal',1,'materialId',pg_temp.video(2),'alias','c2','kind','video'))),
    'createdBy',pg_temp.owner(),'variant',(select variant from private.catalog_generation_intents where id=pg_temp.intent(3)),'feedId',repeat('c',32),'feedBytes',2048,'spaceVariantSetIds',p_sets) $$;
insert into seen select 'feed', to_jsonb(pg_temp.feed('catalog:launch-variants'));
select throws_ok($$select public.service_link_space_catalog_feed(pg_temp.team(),pg_temp.video(1),(pg_temp.v('feed')#>>'{}')::uuid,null,
  pg_temp.record(jsonb_build_array(pg_temp.id(8,30))),pg_temp.owner())$$, 'INVALID_INPUT', 'several sets are at least two');
select throws_ok($$select public.service_link_space_catalog_feed(pg_temp.team(),pg_temp.video(1),(pg_temp.v('feed')#>>'{}')::uuid,null,
  pg_temp.record(jsonb_build_array(pg_temp.id(8,30),pg_temp.id(8,10))),pg_temp.owner())$$, 'WRONG_STATE', 'a set of another creation''s video is refused');
insert into seen select 'linked', public.service_link_space_catalog_feed(pg_temp.team(),pg_temp.video(1),(pg_temp.v('feed')#>>'{}')::uuid,null,
  pg_temp.record(jsonb_build_array(pg_temp.id(8,30),pg_temp.id(8,31))),pg_temp.owner());
select is(pg_temp.v('linked')->>'linked', 'true', 'a catalog of two re-stitched videos links');
select is((select count(*)::int from private.space_catalog_variant_sets where catalog_intent_id=pg_temp.intent(3)
  and state='ready' and catalog_material_id=(pg_temp.v('feed')#>>'{}')::uuid), 2, 'both sets are bound to it');
select is((select array_agg(source_material_id order by source_material_id) from private.catalog_video_r2_uses where catalog_material_id=(pg_temp.v('feed')#>>'{}')::uuid),
  array[pg_temp.video(4),pg_temp.video(5),pg_temp.video(6)], 'and it uses every variation''s copy, no copy of an original');
select is(public.service_space_catalog_variant_links((pg_temp.v('feed')#>>'{}')::uuid), null::jsonb,
  'the updater gets no single list of variations: each block keeps its own');
update private.catalog_generation_intents set state='registered',
  result=jsonb_build_object('catalog',jsonb_build_object('materialId',pg_temp.v('feed')#>>'{}'))
 where id=pg_temp.intent(3);
select lives_ok($$select public.service_attach_launch_catalog_before_catalog_sub(pg_temp.team(),pg_temp.id(5,3),pg_temp.owner(),'owner-3',pg_temp.lease(3))$$,
  'the catalog is attached once every set is bound to it');
update private.space_catalog_variant_sets set catalog_material_id=null where id=pg_temp.id(8,31);
delete from public.team_launch_revision_catalogs where revision_id=pg_temp.id(4,3);
select throws_ok($$select public.service_attach_launch_catalog_before_catalog_sub(pg_temp.team(),pg_temp.id(5,3),pg_temp.owner(),'owner-3',pg_temp.lease(3))$$,
  'PROCESS_RESULT_UNCERTAIN', 'and not while one of them is not');

-- 5. Cancel, and Drive as before -------------------------------------------------------------------
update public.team_launch_generations set state='cancel_requested' where id=pg_temp.id(5,1);
select is((select state from private.space_catalog_variant_sets where id=pg_temp.id(8,10)), 'canceled', 'canceling the Launch stops its set');
select is((select state from public.team_operations where id=(pg_temp.v('run')#>>'{}')::uuid), 'canceled',
  'and the run its agent had open');
select ok(strpos(pg_get_functiondef('public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure),
  $f$  else
  catalog:=public.service_initial_catalog_video_context(p_team,p_actor,(p_config->>'materialId')::uuid,executor,true);$f$) > 0
  and strpos(pg_get_functiondef('private.accept_launch_catalog_video_segments(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb)'::regprocedure),
  'perform public.service_initial_catalog_video_context_before_foreground(p_team, p_actor, (seg->>''materialId'')::uuid, p_executor, true);') > 0,
  'a Drive Launch still proves its executor and accepts its Drive sets');
select ok(private.task_cleanup_coverage_verified(), 'every material reference stays fenced against cleanup races');

select * from finish();
rollback;
