begin;
select plan(17);

-- 057 T118 (20261226340000): the variations of an R2 Launch run on the member's open Soty in the
-- foreground, as on Drive, with background work as the continuation. A Launch whose page hands its
-- variations over (`spaceForeground`) is accepted without background work; without the page it
-- still needs it. Nothing making a set's variations for two minutes reads AGENT_REQUIRED in the
-- Launch's progress and the dialog's read; a page's open run and a background lease keep each
-- variation to one machine. Drive's acceptance lines are the text they were.
--
-- The Launch's inner admission and the frozen resources are stubbed in this transaction, as in
-- launch-space-catalog-variants.test.sql.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05791180-0000-4000-8000-000000000001','authenticated','authenticated','launch-foreground-owner@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values ('05791180-0000-4000-8000-000000000001',50000000);
insert into public.teams(id,name,owner_id,storage_backend,storage_pilot) values
 ('05791180-0000-4000-8000-000000000011','Launch foreground R2','05791180-0000-4000-8000-000000000001','r2',true);
insert into public.team_members(team_id,user_id,base_role) values
 ('05791180-0000-4000-8000-000000000011','05791180-0000-4000-8000-000000000001','admin')
 on conflict do nothing;
insert into public.team_materials(id,team_id,name,kind) values
 ('05791180-0000-4000-8000-000000000101','05791180-0000-4000-8000-000000000011','Launch foreground R2','folder');
update public.teams set storage_root_material_id='05791180-0000-4000-8000-000000000101'
 where id='05791180-0000-4000-8000-000000000011';
insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key,state)
select ('05791180-0000-4000-8000-0000000002'||lpad(n::text,2,'0'))::uuid,'05791180-0000-4000-8000-000000000011',repeat(n::text,64),
  1000*n,'video/mp4','t/05791180-0000-4000-8000-000000000011/o/'||repeat(n::text,64),'committed'
from generate_series(1,6) n;
-- 1..3 are the creatives, 4..6 the variations' outputs.
insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,mime_type,space_object_id,size_bytes)
select ('05791180-0000-4000-8000-0000000001'||lpad((10+n)::text,2,'0'))::uuid,'05791180-0000-4000-8000-000000000011',
  '05791180-0000-4000-8000-000000000101','video-'||n||'.mp4','file','video','video/mp4',
  ('05791180-0000-4000-8000-0000000002'||lpad(n::text,2,'0'))::uuid,1000*n
from generate_series(1,6) n;
update private.catalog_video_r2_config set enabled=true, public_origin='https://videos.test', policy_confirmed_at=now();

create temporary table seen(label text, value jsonb);
create function pg_temp.v(p_label text) returns jsonb language sql as $$ select value from seen where label=p_label order by ctid desc limit 1 $$;
create function pg_temp.team() returns uuid language sql as $$ select '05791180-0000-4000-8000-000000000011'::uuid $$;
create function pg_temp.owner() returns uuid language sql as $$ select '05791180-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.video(n int) returns uuid language sql as $$ select ('05791180-0000-4000-8000-0000000001'||lpad((10+n)::text,2,'0'))::uuid $$;
create function pg_temp.id(p_kind int, n int) returns uuid language sql as $$ select ('05791180-0000-4000-8000-00000000'||p_kind::text||lpad(n::text,3,'0'))::uuid $$;

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
create function pg_temp.progress(g int) returns jsonb language sql as $$
  select private.launch_space_video_generation_json(pg_temp.team(),pg_temp.id(5,g)) $$;
create function pg_temp.delegate() returns void language sql as $$
  insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash) values
   (pg_temp.team(),pg_temp.owner(),'05791180-0000-4000-8000-000000000901',sha256('launch-foreground'::bytea)) $$;
create function pg_temp.age(g int) returns text language sql as $$
  update private.space_catalog_variant_sets set created_at=clock_timestamp()-interval '3 minutes' where catalog_intent_id=pg_temp.intent(g);
  update private.space_catalog_variants v set updated_at=clock_timestamp()-interval '3 minutes'
   from private.space_catalog_variant_sets s where s.id=v.set_id and s.catalog_intent_id=pg_temp.intent(g);
  -- The operation's own trigger stamps updated_at: the clock is turned back past it.
  select set_config('session_replication_role','replica',true);
  update public.team_operations o set updated_at=clock_timestamp()-interval '3 minutes'
   from private.space_catalog_variants v join private.space_catalog_variant_sets s on s.id=v.set_id
   where o.id=v.operation_id and s.catalog_intent_id=pg_temp.intent(g);
  select set_config('session_replication_role','origin',true);
$$;

-- 1. No Soty open and no background work: nothing is accepted ------------------------------------
insert into seen select 'g1', to_jsonb(pg_temp.generation(1));
select throws_ok($$select pg_temp.accept(1,1,2)$$, 'AGENT_REQUIRED',
  'without the member''s open Soty or background work an R2 Launch is refused, as on Drive');

-- 2. The page hands the variations to the member's open Soty ------------------------------------
create function pg_temp.accept_foreground(g int, k int, variants int) returns jsonb language sql as $$
  select public.service_accept_launch_catalog_video_generation(pg_temp.team(),pg_temp.id(3,g),pg_temp.owner(),'1','launch-key-'||g,'digest',
    pg_temp.config(k,variants,2*k),
    jsonb_build_object('materialType','video','restitchSettingsVersion',private.launch_restitch_settings_version(pg_temp.team(),pg_temp.owner())),
    '{"advertisingUrl":"https://offer.test/?s=1"}',pg_temp.video_admission(g,k,variants)||'{"spaceForeground":true}'::jsonb) $$;
select lives_ok($$select pg_temp.accept_foreground(1,1,2)$$,
  'a Launch whose page hands its variations to the member''s open Soty needs no background work');
select is((select state||':'||variant_count from private.space_catalog_variant_sets where catalog_intent_id=pg_temp.intent(1)), 'preparing:2',
  'its variations are the space''s set, as any R2 Launch''s');
select is((select executor_id from private.launch_catalog_video_contexts where generation_id=pg_temp.id(5,1)), null,
  'and it still names no executor');
select ok(not (pg_temp.progress(1) ? 'waitReason'), 'freshly accepted, it waits for the page to hand the first one over');
select is(pg_temp.progress(1)->'spaceSets', jsonb_build_array(jsonb_build_object('setId',pg_temp.id(8,10),'requestedCount',2,'registeredCount',0)),
  'its progress names the set the page hands over');

-- 3. The page hands a variation over: one machine per variation ---------------------------------
insert into seen select 'set1', to_jsonb((select id from private.space_catalog_variant_sets where catalog_intent_id=pg_temp.intent(1)));
create function pg_temp.set1() returns uuid language sql as $$ select (pg_temp.v('set1')#>>'{}')::uuid $$;
select is(public.service_space_catalog_variant_run(pg_temp.team(),pg_temp.owner(),pg_temp.set1(),0)->>'state', 'open',
  'the page is handed the first variation to open');
insert into seen select 'run0', to_jsonb((select operation_id from public.service_start_team_operation(pg_temp.team(),pg_temp.owner(),'process',
  'space-variant:'||pg_temp.id(7,10)||':1','space-variant:'||pg_temp.id(7,10)||':1',pg_temp.video(1),
  '05791180-0000-4000-8000-000000000101','variant.mp4',now()+interval '1 hour',null)));
update private.space_catalog_variants set operation_id=(pg_temp.v('run0')#>>'{}')::uuid, attempt=1 where set_id=pg_temp.set1() and ordinal=0;
select is(public.service_space_catalog_variant_run(pg_temp.team(),pg_temp.owner(),pg_temp.set1(),0)->>'state', 'running',
  'a run already open is handed out again, never a second one');
insert into seen select 'delegate', to_jsonb(pg_temp.delegate() is null);
insert into seen select 'claim', public.service_claim_space_catalog_variant(pg_temp.team(),pg_temp.owner(),sha256('lease-1'::bytea),120);
select is((pg_temp.v('claim')->>'index')::int, 1, 'background work takes the next variation, not the one the page runs');
select is(public.service_space_catalog_variant_run(pg_temp.team(),pg_temp.owner(),pg_temp.set1(),1)->>'state', 'background',
  'and the page waits for the one background work holds');
delete from private.team_recovery_delegations where team_id=pg_temp.team();
update private.space_catalog_variants set job_id=null, lease_hash=null, lease_expires_at=null where set_id=pg_temp.set1();

-- 4. Nothing makes them: the progress says so ---------------------------------------------------
insert into seen select 'age', to_jsonb(pg_temp.age(1));
select ok(not (pg_temp.progress(1) ? 'waitReason'), 'while a run is open, something is making them');
insert into seen select 'transition', to_jsonb(public.service_transition_team_operation((pg_temp.v('run0')#>>'{}')::uuid,'running','running',0,null,null,false));
insert into seen select 'transition', to_jsonb(public.service_transition_team_operation((pg_temp.v('run0')#>>'{}')::uuid,'failed','failed',0,null,'PROCESS_FAILED',false));
insert into seen select 'age', to_jsonb(pg_temp.age(1));
select is(pg_temp.progress(1)->>'waitReason', 'AGENT_REQUIRED',
  'with no open run, no background work and nothing moving for two minutes, the progress says AGENT_REQUIRED');
select set_config('request.jwt.claim.sub',pg_temp.owner()::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.owner(),'role','authenticated')::text,true);
select is(public.get_launch(pg_temp.team(),pg_temp.id(3,1)) #>> '{generation,videoGeneration,waitReason}', 'AGENT_REQUIRED',
  'and the Launch shows it');
select is(public.service_read_space_catalog_variants(pg_temp.team(),pg_temp.owner(),'launch:'||pg_temp.id(5,1)||':catalog')->>'waitReason',
  'AGENT_REQUIRED', 'the creation''s own read says it too');
insert into seen select 'delegate', to_jsonb(pg_temp.delegate() is null);
select ok(not (pg_temp.progress(1) ? 'waitReason'), 'background work makes them: nothing to say');
delete from private.team_recovery_delegations where team_id=pg_temp.team();

-- 5. Background work alone, as before; Drive untouched -------------------------------------------
insert into seen select 'g2', to_jsonb(pg_temp.generation(2));
insert into seen select 'delegate', to_jsonb(pg_temp.delegate() is null);
select lives_ok($$select pg_temp.accept(2,1,2)$$, 'background work alone is accepted, as before');
select ok(strpos(pg_get_functiondef('public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure),
  $s$  catalog:=public.service_initial_catalog_video_context(p_team,p_actor,(p_config->>'materialId')::uuid,executor,true);
  if executor is null or catalog->>'executorId' is distinct from executor::text or coalesce(preferences#>>'{foregroundExecutor,enrollmentId}',preferences->>'expectedExecutorId') is distinct from executor::text then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;$s$) > 0,
  'the Drive acceptance asks for its executor exactly as before');

select * from finish();
rollback;
