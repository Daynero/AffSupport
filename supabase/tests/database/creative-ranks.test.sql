begin;
select plan(36);

-- Deferred crediting fires at commit; a test transaction never commits, so make it immediate.
set constraints public.team_launch_generations_credit_rank, public.team_product_catalogs_credit_rank,
 public.team_launch_revision_catalogs_credit_rank immediate;

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c5900000-0000-4000-8000-000000000001','authenticated','authenticated','ranks-owner@test.invalid','{}','{}'),
 ('c5900000-0000-4000-8000-000000000002','authenticated','authenticated','ranks-editor@test.invalid','{}','{}'),
 ('c5900000-0000-4000-8000-000000000003','authenticated','authenticated','ranks-stranger@test.invalid','{}','{}');
-- An admin owner keeps the fixture space open without a tariff row.
insert into public.admin_users(user_id) values('c5900000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('c5900000-0000-4000-8000-000000000011','Ranks fixture','c5900000-0000-4000-8000-000000000001'),
 ('c5900000-0000-4000-8000-000000000012','Other fixture','c5900000-0000-4000-8000-000000000003');
insert into public.team_members(team_id,user_id,base_role) values
 ('c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000001','admin'),
 ('c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000002','editor'),
 ('c5900000-0000-4000-8000-000000000012','c5900000-0000-4000-8000-000000000003','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('c5900000-0000-4000-8000-000000000021','c5900000-0000-4000-8000-000000000001','ranks-test','ranks-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('c5900000-0000-4000-8000-000000000031','c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000021','ranks-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values
 ('c5900000-0000-4000-8000-000000000041','c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000031','ranks-v1','V1','file','video','video/mp4','1'),
 ('c5900000-0000-4000-8000-000000000042','c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000031','ranks-v2','V2','file','video','video/mp4','1'),
 ('c5900000-0000-4000-8000-000000000051','c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000031','ranks-c1','C1','file','other','application/vnd.google-apps.spreadsheet','1'),
 ('c5900000-0000-4000-8000-000000000052','c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000031','ranks-c2','C2','file','other','application/vnd.google-apps.spreadsheet','1'),
 ('c5900000-0000-4000-8000-000000000053','c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000031','ranks-c3','C3','file','other','application/vnd.google-apps.spreadsheet','1'),
 ('c5900000-0000-4000-8000-000000000054','c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000031','ranks-c4','C4','file','other','application/vnd.google-apps.spreadsheet','1'),
 ('c5900000-0000-4000-8000-000000000055','c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000031','ranks-c5','C5','file','other','application/vnd.google-apps.spreadsheet','1'),
 ('c5900000-0000-4000-8000-000000000056','c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000031','ranks-c6','C6','file','other','application/vnd.google-apps.spreadsheet','1'),
 ('c5900000-0000-4000-8000-000000000057','c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000031','ranks-c7','C7','file','other','application/vnd.google-apps.spreadsheet','1');

-- Fixture helpers: a Launch with one revision for a video, and a generation in a given state.
create function pg_temp.launch(p_launch uuid, p_video uuid) returns void language sql as $$
 insert into public.team_launches(id,team_id,created_by) values(p_launch,'c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000001');
$$;
create function pg_temp.revision(p_revision uuid, p_launch uuid, p_video uuid, p_no integer) returns void language sql as $$
 insert into public.team_launch_revisions(id,team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)
 values(p_revision,'c5900000-0000-4000-8000-000000000011',p_launch,p_no,'generated',
   jsonb_build_object('materialId',p_video,'method','other'),'{}','https://offer.example.invalid/','https://offer.example.invalid/?s=1','{}','c5900000-0000-4000-8000-000000000001');
$$;
create function pg_temp.generation(p_generation uuid, p_launch uuid, p_revision uuid) returns void language sql as $$
 insert into public.team_launch_generations(id,team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state)
 values(p_generation,'c5900000-0000-4000-8000-000000000011',p_launch,p_revision,'c5900000-0000-4000-8000-000000000001',
   'ranks-'||p_generation::text,'digest','v1','running');
$$;
create function pg_temp.finish(p_generation uuid, p_state text) returns void language sql as $$
 update public.team_launch_generations set state=p_state,updated_at=clock_timestamp() where id=p_generation;
$$;
create function pg_temp.count_of(p_video uuid) returns integer language sql as $$
 select coalesce((select launch_count from public.team_creative_ranks where team_id='c5900000-0000-4000-8000-000000000011' and material_id=p_video),0);
$$;
create function pg_temp.attach(p_revision uuid, p_sheet uuid) returns void language sql as $$
 insert into public.team_launch_revision_catalogs(team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,settings_snapshot)
 values('c5900000-0000-4000-8000-000000000011',p_revision,p_sheet,p_sheet,1,'sheet','https://docs.google.com/spreadsheets/d/'||p_sheet::text||'/edit','{}');
$$;
create function pg_temp.catalog(p_sheet uuid, p_video uuid) returns void language sql as $$
 insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)
 values(p_sheet,'c5900000-0000-4000-8000-000000000011',p_video,'https://offer.example.invalid/',2,
   'https://docs.google.com/spreadsheets/d/'||p_sheet::text||'/edit','https://drive.google.com/file/d/v/view','{}');
$$;

-- Structure and access.
select has_table('public','team_creative_launch_events','launch ledger exists');
select has_table('public','team_creative_ranks','rank projection exists');
select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
 where oid in('public.team_creative_launch_events'::regclass,'public.team_creative_ranks'::regclass)),'rank tables force RLS');
select ok(not has_table_privilege('authenticated','public.team_creative_ranks','select,insert,update,delete'),'browser has no direct rank access');
select ok(not has_table_privilege('authenticated','public.team_creative_launch_events','select,insert,update,delete'),'browser has no direct ledger access');
select ok(not has_function_privilege('authenticated','private.apply_creative_rank_event(uuid,uuid,text,uuid,timestamptz,uuid,boolean)','execute'),'browser cannot credit a launch');
select is_empty($$
 select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in('list_creative_ranks','demote_creative_rank')
 and (not p.prosecdef or not ('search_path=""'=any(p.proconfig)))
$$,'rank RPCs are definer functions with a closed search path');

-- First success credits; a second success of the same Launch does not.
select pg_temp.launch('c5900000-0000-4000-8000-000000000101','c5900000-0000-4000-8000-000000000041');
select pg_temp.revision('c5900000-0000-4000-8000-000000000201','c5900000-0000-4000-8000-000000000101','c5900000-0000-4000-8000-000000000041',1);
select pg_temp.generation('c5900000-0000-4000-8000-000000000301','c5900000-0000-4000-8000-000000000101','c5900000-0000-4000-8000-000000000201');
select pg_temp.finish('c5900000-0000-4000-8000-000000000301','succeeded');
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000041'),1,'first successful generation credits the video');
select pg_temp.revision('c5900000-0000-4000-8000-000000000202','c5900000-0000-4000-8000-000000000101','c5900000-0000-4000-8000-000000000041',2);
select pg_temp.generation('c5900000-0000-4000-8000-000000000302','c5900000-0000-4000-8000-000000000101','c5900000-0000-4000-8000-000000000202');
select pg_temp.finish('c5900000-0000-4000-8000-000000000302','succeeded');
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000041'),1,'regenerating the same Launch is not a second launch');

-- Failure and cancellation credit nothing.
select pg_temp.launch('c5900000-0000-4000-8000-000000000102','c5900000-0000-4000-8000-000000000041');
select pg_temp.revision('c5900000-0000-4000-8000-000000000203','c5900000-0000-4000-8000-000000000102','c5900000-0000-4000-8000-000000000041',1);
select pg_temp.generation('c5900000-0000-4000-8000-000000000303','c5900000-0000-4000-8000-000000000102','c5900000-0000-4000-8000-000000000203');
select pg_temp.finish('c5900000-0000-4000-8000-000000000303','failed');
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000041'),1,'a failed generation credits nothing');

-- Four Launches in a batch: four launches.
select pg_temp.launch(('c5900000-0000-4000-8000-00000000011'||n)::uuid,'c5900000-0000-4000-8000-000000000041') from generate_series(0,3) n;
select pg_temp.revision(('c5900000-0000-4000-8000-00000000021'||n)::uuid,('c5900000-0000-4000-8000-00000000011'||n)::uuid,'c5900000-0000-4000-8000-000000000041',1) from generate_series(0,3) n;
select pg_temp.generation(('c5900000-0000-4000-8000-00000000031'||n)::uuid,('c5900000-0000-4000-8000-00000000011'||n)::uuid,('c5900000-0000-4000-8000-00000000021'||n)::uuid) from generate_series(0,3) n;
update public.team_launch_generations set state='succeeded',updated_at=clock_timestamp()
 where id in(select ('c5900000-0000-4000-8000-00000000031'||n)::uuid from generate_series(0,3) n);
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000041'),5,'a batch of four Launches adds four');

-- A catalog made directly credits once.
select pg_temp.catalog('c5900000-0000-4000-8000-000000000051','c5900000-0000-4000-8000-000000000041');
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000041'),6,'a direct catalog credits the video');

-- A Launch's own catalog, registered before success: the pair counts once.
select pg_temp.launch('c5900000-0000-4000-8000-000000000103','c5900000-0000-4000-8000-000000000041');
select pg_temp.revision('c5900000-0000-4000-8000-000000000204','c5900000-0000-4000-8000-000000000103','c5900000-0000-4000-8000-000000000041',1);
select pg_temp.catalog('c5900000-0000-4000-8000-000000000052','c5900000-0000-4000-8000-000000000041');
insert into public.team_launch_revision_catalogs(team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,settings_snapshot)
 values('c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000204','c5900000-0000-4000-8000-000000000052','c5900000-0000-4000-8000-000000000052',1,'C2','https://docs.google.com/spreadsheets/d/c2/edit','{}');
select pg_temp.generation('c5900000-0000-4000-8000-000000000304','c5900000-0000-4000-8000-000000000103','c5900000-0000-4000-8000-000000000204');
select pg_temp.finish('c5900000-0000-4000-8000-000000000304','succeeded');
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000041'),7,'catalog then Launch success counts once');
select is((select absorbed_by_launch_id from public.team_creative_launch_events where source_kind='catalog' and source_id='c5900000-0000-4000-8000-000000000052'),
 'c5900000-0000-4000-8000-000000000103'::uuid,'the Launch absorbed its own catalog');

-- The other order: Launch success first, its catalog afterwards.
select pg_temp.launch('c5900000-0000-4000-8000-000000000104','c5900000-0000-4000-8000-000000000042');
select pg_temp.revision('c5900000-0000-4000-8000-000000000205','c5900000-0000-4000-8000-000000000104','c5900000-0000-4000-8000-000000000042',1);
insert into public.team_launch_revision_catalogs(team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,settings_snapshot)
 values('c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000205','c5900000-0000-4000-8000-000000000053','c5900000-0000-4000-8000-000000000053',1,'C3','https://docs.google.com/spreadsheets/d/c3/edit','{}');
select pg_temp.generation('c5900000-0000-4000-8000-000000000305','c5900000-0000-4000-8000-000000000104','c5900000-0000-4000-8000-000000000205');
select pg_temp.finish('c5900000-0000-4000-8000-000000000305','succeeded');
select pg_temp.catalog('c5900000-0000-4000-8000-000000000053','c5900000-0000-4000-8000-000000000042');
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000042'),1,'Launch success then its catalog counts once');

-- A regeneration makes a new sheet: the sheet is registered first, attached to the Launch later.
select pg_temp.revision('c5900000-0000-4000-8000-000000000221','c5900000-0000-4000-8000-000000000104','c5900000-0000-4000-8000-000000000042',2);
select pg_temp.catalog('c5900000-0000-4000-8000-000000000054','c5900000-0000-4000-8000-000000000042');
select pg_temp.attach('c5900000-0000-4000-8000-000000000221','c5900000-0000-4000-8000-000000000054');
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000042'),1,'a regeneration''s new sheet is absorbed when attached');
select pg_temp.generation('c5900000-0000-4000-8000-000000000321','c5900000-0000-4000-8000-000000000104','c5900000-0000-4000-8000-000000000221');
select pg_temp.finish('c5900000-0000-4000-8000-000000000321','succeeded');
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000042'),1,'regenerating with a new sheet is still one launch');

-- The other order: attached first, the sheet's own row afterwards.
select pg_temp.revision('c5900000-0000-4000-8000-000000000222','c5900000-0000-4000-8000-000000000104','c5900000-0000-4000-8000-000000000042',3);
select pg_temp.attach('c5900000-0000-4000-8000-000000000222','c5900000-0000-4000-8000-000000000055');
select pg_temp.catalog('c5900000-0000-4000-8000-000000000055','c5900000-0000-4000-8000-000000000042');
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000042'),1,'a regeneration sheet registered after attaching is absorbed');

-- A sheet from a canceled first attempt belongs to the Launch that later succeeds without one.
select pg_temp.launch('c5900000-0000-4000-8000-000000000106','c5900000-0000-4000-8000-000000000042');
select pg_temp.revision('c5900000-0000-4000-8000-000000000223','c5900000-0000-4000-8000-000000000106','c5900000-0000-4000-8000-000000000042',1);
select pg_temp.catalog('c5900000-0000-4000-8000-000000000056','c5900000-0000-4000-8000-000000000042');
select pg_temp.attach('c5900000-0000-4000-8000-000000000223','c5900000-0000-4000-8000-000000000056');
select pg_temp.generation('c5900000-0000-4000-8000-000000000323','c5900000-0000-4000-8000-000000000106','c5900000-0000-4000-8000-000000000223');
select pg_temp.finish('c5900000-0000-4000-8000-000000000323','canceled');
select pg_temp.revision('c5900000-0000-4000-8000-000000000224','c5900000-0000-4000-8000-000000000106','c5900000-0000-4000-8000-000000000042',2);
select pg_temp.generation('c5900000-0000-4000-8000-000000000324','c5900000-0000-4000-8000-000000000106','c5900000-0000-4000-8000-000000000224');
select pg_temp.finish('c5900000-0000-4000-8000-000000000324','succeeded');
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000042'),2,'a canceled attempt''s sheet and the later success are one launch');

-- Deferred, as in production: sheet, attachment and success in one transaction, credited at commit.
set constraints public.team_launch_generations_credit_rank, public.team_product_catalogs_credit_rank,
 public.team_launch_revision_catalogs_credit_rank deferred;
select pg_temp.launch('c5900000-0000-4000-8000-000000000107','c5900000-0000-4000-8000-000000000042');
select pg_temp.revision('c5900000-0000-4000-8000-000000000225','c5900000-0000-4000-8000-000000000107','c5900000-0000-4000-8000-000000000042',1);
select pg_temp.catalog('c5900000-0000-4000-8000-000000000057','c5900000-0000-4000-8000-000000000042');
select pg_temp.attach('c5900000-0000-4000-8000-000000000225','c5900000-0000-4000-8000-000000000057');
select pg_temp.generation('c5900000-0000-4000-8000-000000000325','c5900000-0000-4000-8000-000000000107','c5900000-0000-4000-8000-000000000225');
select pg_temp.finish('c5900000-0000-4000-8000-000000000325','succeeded');
set constraints public.team_launch_generations_credit_rank, public.team_product_catalogs_credit_rank,
 public.team_launch_revision_catalogs_credit_rank immediate;
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000042'),3,'deferred crediting counts the pair once at commit');

-- A video id written in capitals is still the video.
select pg_temp.launch('c5900000-0000-4000-8000-000000000108','c5900000-0000-4000-8000-000000000042');
insert into public.team_launch_revisions(id,team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)
values('c5900000-0000-4000-8000-000000000226','c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000108',1,'generated',
  jsonb_build_object('materialId','C5900000-0000-4000-8000-000000000042','method','other'),'{}','https://offer.example.invalid/','https://offer.example.invalid/?s=1','{}','c5900000-0000-4000-8000-000000000001');
select pg_temp.generation('c5900000-0000-4000-8000-000000000326','c5900000-0000-4000-8000-000000000108','c5900000-0000-4000-8000-000000000226');
select pg_temp.finish('c5900000-0000-4000-8000-000000000326','succeeded');
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000042'),4,'an upper-case video id is credited');

-- Archiving a Launch and replaying an event change nothing.
update public.team_launches set archived_at=now() where id='c5900000-0000-4000-8000-000000000101';
select is(pg_temp.count_of('c5900000-0000-4000-8000-000000000041'),7,'archiving a Launch keeps the record');
select is(private.apply_creative_rank_event('c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000041','launch',
 'c5900000-0000-4000-8000-000000000101',now(),null,true),false,'a replayed event is ignored');
select ok((select count(*) from public.team_catalog_events where team_id='c5900000-0000-4000-8000-000000000011' and event_kind='creative_rank')>0,
 'rank changes are announced for realtime');
select ok((select last_launched_at from public.team_creative_ranks where material_id='c5900000-0000-4000-8000-000000000041') is not null,
 'last launch time is kept');

-- Reading.
set local role authenticated;
set local request.jwt.claim.sub = 'c5900000-0000-4000-8000-000000000002';
select is(jsonb_array_length(public.list_creative_ranks('c5900000-0000-4000-8000-000000000011',
 array['c5900000-0000-4000-8000-000000000041','c5900000-0000-4000-8000-000000000042','c5900000-0000-4000-8000-000000000051']::uuid[])),2,
 'a member reads ranks for the videos that have one');
select throws_ok($$select public.list_creative_ranks('c5900000-0000-4000-8000-000000000011','{}'::uuid[])$$,'22023',null,'an empty read is refused');

-- Demotion: owner only, lower only, once.
select throws_ok($$select public.demote_creative_rank('c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000041','disappointed',5,
 (select version from public.team_creative_ranks where material_id='c5900000-0000-4000-8000-000000000041'),'editor-attempt-1')$$,'42501',null,'an editor cannot demote');
set local request.jwt.claim.sub = 'c5900000-0000-4000-8000-000000000003';
select throws_ok($$select public.list_creative_ranks('c5900000-0000-4000-8000-000000000011',array['c5900000-0000-4000-8000-000000000041']::uuid[])$$,
 '42501',null,'another space cannot read ranks');
reset role;
create temporary table rank_before as select version, rank_credit from public.team_creative_ranks where material_id='c5900000-0000-4000-8000-000000000041';
grant select on rank_before to authenticated;
set local role authenticated;
set local request.jwt.claim.sub = 'c5900000-0000-4000-8000-000000000001';
select throws_ok($$select public.demote_creative_rank('c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000041','disappointed',5,
 (select version - 1 from rank_before),'owner-attempt-0')$$,'PT409','RANK_CONFLICT','a stale version is a conflict');
select throws_ok($$select public.demote_creative_rank('c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000041','disappointed',7,
 (select version from rank_before),'owner-attempt-0')$$,'PT409','RANK_NOT_LOWER','demotion must lower');
select is((public.demote_creative_rank('c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000041','disappointed',5,
 (select version from rank_before),'owner-attempt-1')->>'rankCredit')::integer,5,'the owner demotes Gold to Silver');
select is((public.demote_creative_rank('c5900000-0000-4000-8000-000000000011','c5900000-0000-4000-8000-000000000041','disappointed',5,
 (select version from rank_before),'owner-attempt-1')->>'rankCredit')::integer,5,'a repeated demotion request is the same demotion');
reset role;
select is((select launch_count from public.team_creative_ranks where material_id='c5900000-0000-4000-8000-000000000041'),7,'demotion keeps the launch count');

-- The backfill run again over the same history changes nothing, demotion included.
create temporary table ranks_before_backfill as
 select material_id, launch_count, rank_credit, last_launched_at from public.team_creative_ranks
  where team_id='c5900000-0000-4000-8000-000000000011';
select private.backfill_creative_ranks();
select is_empty($$
 (select material_id, launch_count, rank_credit, last_launched_at from public.team_creative_ranks
   where team_id='c5900000-0000-4000-8000-000000000011'
  except select * from ranks_before_backfill)
 union all
 (select * from ranks_before_backfill
  except select material_id, launch_count, rank_credit, last_launched_at from public.team_creative_ranks
   where team_id='c5900000-0000-4000-8000-000000000011')
$$,'rerunning the backfill agrees with what the triggers built');

-- New launches lift a demoted creative again from its new credit.
select pg_temp.launch('c5900000-0000-4000-8000-000000000105','c5900000-0000-4000-8000-000000000041');
select pg_temp.revision('c5900000-0000-4000-8000-000000000206','c5900000-0000-4000-8000-000000000105','c5900000-0000-4000-8000-000000000041',1);
select pg_temp.generation('c5900000-0000-4000-8000-000000000306','c5900000-0000-4000-8000-000000000105','c5900000-0000-4000-8000-000000000206');
select pg_temp.finish('c5900000-0000-4000-8000-000000000306','succeeded');
select is((select array[launch_count,rank_credit] from public.team_creative_ranks where material_id='c5900000-0000-4000-8000-000000000041'),
 array[8,6],'a new launch after demotion grows both numbers');

select * from finish();
rollback;
