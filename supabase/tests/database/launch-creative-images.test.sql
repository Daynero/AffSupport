begin;
select plan(22);

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c0621000-0000-4000-8000-000000000001','authenticated','authenticated','images-owner@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c0621000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values('c0621000-0000-4000-8000-000000000011','Creative images fixture','c0621000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values('c0621000-0000-4000-8000-000000000011','c0621000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('c0621000-0000-4000-8000-000000000021','c0621000-0000-4000-8000-000000000001','images-test','images-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('c0621000-0000-4000-8000-000000000031','c0621000-0000-4000-8000-000000000011','c0621000-0000-4000-8000-000000000021','images-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum) values
 ('c0621000-0000-4000-8000-000000000041','c0621000-0000-4000-8000-000000000011','c0621000-0000-4000-8000-000000000031','img-1','One.png','file','image','image/png','7','0123456789abcdef0123456789abcdef'),
 ('c0621000-0000-4000-8000-000000000042','c0621000-0000-4000-8000-000000000011','c0621000-0000-4000-8000-000000000031','vid-1','One.mp4','file','video','video/mp4','1','1123456789abcdef0123456789abcdef'),
 ('c0621000-0000-4000-8000-000000000051','c0621000-0000-4000-8000-000000000011','c0621000-0000-4000-8000-000000000031','sheet-1','Sheet','file','other','application/vnd.google-apps.spreadsheet','1',null);
insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)
 values('c0621000-0000-4000-8000-000000000051','c0621000-0000-4000-8000-000000000011','c0621000-0000-4000-8000-000000000041','https://offer.example.invalid/',1,
  'https://docs.google.com/spreadsheets/d/s1/edit',null,'{"_catalogCreativeKind":"image"}');
create temporary table probe(key text primary key, value jsonb);
create function pg_temp.reserve(p_attempt uuid) returns jsonb language sql as $$
 select public.service_reserve_launch_creative_image('c0621000-0000-4000-8000-000000000011','c0621000-0000-4000-8000-000000000041','7','0123456789ABCDEF0123456789abcdef',p_attempt);
$$;
create function pg_temp.url(p jsonb) returns text language sql as $$ select 'https://images.example.invalid/'||(p->>'objectKey') $$;

-- Access.
select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in('private.launch_creative_images'::regclass,'private.launch_creative_image_uses'::regclass)),'creative image tables force RLS');
select ok(not has_table_privilege('service_role','private.launch_creative_images','select,insert,update,delete') and not has_table_privilege('authenticated','private.launch_creative_image_uses','select,insert,update,delete'),'tables are reachable only through definer functions');
select ok(has_function_privilege('service_role','public.service_reserve_launch_creative_image(uuid,uuid,text,text,uuid)','execute') and not has_function_privilege('authenticated','public.service_reserve_launch_creative_image(uuid,uuid,text,text,uuid)','execute'),'reservation is service only');
select ok(private.task_cleanup_coverage_verified(),'both tables keep the cleanup fence');

-- Reservation and dedup.
insert into probe values('r1',pg_temp.reserve('c0621000-0000-4000-8000-000000000101'));
select is((select value->>'state' from probe where key='r1'),'reserved','a new source is reserved');
select ok((select value->>'objectKey' ~ '^c1/[0-9a-f-]{36}$' from probe where key='r1'),'the key has the c1/<uuid> shape');
select is(pg_temp.reserve('c0621000-0000-4000-8000-000000000101')->>'id',(select value->>'id' from probe where key='r1'),'the same attempt replays its reservation');
select is(pg_temp.reserve('c0621000-0000-4000-8000-000000000102')->>'objectKey',(select value->>'objectKey' from probe where key='r1'),'a later attempt takes the reservation over with the same key');
select throws_ok($$select public.service_reserve_launch_creative_image('c0621000-0000-4000-8000-000000000011','c0621000-0000-4000-8000-000000000041','8','0123456789abcdef0123456789abcdef',gen_random_uuid())$$,'55000','SOURCE_CHANGED','another Drive version is refused');
select throws_ok($$select public.service_reserve_launch_creative_image('c0621000-0000-4000-8000-000000000011','c0621000-0000-4000-8000-000000000042','1','1123456789abcdef0123456789abcdef',gen_random_uuid())$$,'55000','SOURCE_CHANGED','a video is not an image creative');

-- Commit.
select throws_ok($$select public.service_commit_launch_creative_image((select (value->>'id')::uuid from probe where key='r1'),'c0621000-0000-4000-8000-000000000101',(select pg_temp.url(value) from probe where key='r1'),'image/png',1000)$$,'55000','WRONG_STATE','a stale attempt cannot commit');
select throws_ok($$select public.service_commit_launch_creative_image((select (value->>'id')::uuid from probe where key='r1'),'c0621000-0000-4000-8000-000000000102','https://images.example.invalid/c1/other?x=1','image/png',1000)$$,'22023','INVALID_INPUT','the URL must name the reserved key');
insert into probe values('c1',public.service_commit_launch_creative_image((select (value->>'id')::uuid from probe where key='r1'),'c0621000-0000-4000-8000-000000000102',(select pg_temp.url(value) from probe where key='r1'),'image/png',1000));
select is((select value->>'state' from probe where key='c1'),'ready','a verified write commits the URL');
select ok((select state='retiring' and retire_after > clock_timestamp()+interval '5 hours' from private.launch_creative_images where id=(select (value->>'id')::uuid from probe where key='r1')),'an unused image holds for six hours');
select is(pg_temp.reserve(gen_random_uuid())->>'url',(select pg_temp.url(value) from probe where key='r1'),'another Launch of the same file reuses the URL');

-- Uses.
select lives_ok($$select public.service_confirm_launch_creative_image_uses('c0621000-0000-4000-8000-000000000051',array[(select (value->>'id')::uuid from probe where key='r1')])$$,'catalog registration confirms its uses');
select ok((select state='ready' and retire_after is null from private.launch_creative_images where id=(select (value->>'id')::uuid from probe where key='r1')),'a used image is ready');
select is((select count(*)::int from public.service_sweep_launch_creative_images(10)),0,'a used image is never swept');
select lives_ok($$select public.service_confirm_launch_creative_image_uses('c0621000-0000-4000-8000-000000000051','{}')$$,'dropping the last use');
select ok((select state='retiring' from private.launch_creative_images where id=(select (value->>'id')::uuid from probe where key='r1')),'without uses the image retires');
update private.launch_creative_images set retire_after=clock_timestamp()-interval '1 minute' where id=(select (value->>'id')::uuid from probe where key='r1');
select is((select object_key from public.service_sweep_launch_creative_images(10)),(select value->>'objectKey' from probe where key='r1'),'a retired image past its hold is swept');
select public.service_mark_launch_creative_image_purged((select (value->>'id')::uuid from probe where key='r1'));
select is(pg_temp.reserve(gen_random_uuid())->>'state','reserved','after purge the source is published anew');

select * from finish();
rollback;
