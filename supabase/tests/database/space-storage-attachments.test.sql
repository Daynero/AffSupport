begin;
select plan(14);

-- 057 T030: task attachments in an R2 space (20261226180000). An attachment references its
-- object in the `attachments` category; a file a task upload brought in counts as attachments;
-- detaching never deletes a material that is still in the explorer, and a task-owned upload is
-- cleaned into the space's trash without Drive. The cleanup fence still covers every table.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05730000-0000-4000-8000-000000000001','authenticated','authenticated','owner30@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values ('05730000-0000-4000-8000-000000000001',100000);

create temporary table seen(label text, value jsonb);
grant all on seen to authenticated;
create function pg_temp.owner() returns uuid language sql as $$ select '05730000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.team() returns uuid language sql as $$ select (value->>'teamId')::uuid from seen where label='space' $$;
create function pg_temp.root() returns uuid language sql as $$ select (value->>'rootMaterialId')::uuid from seen where label='space' $$;
create function pg_temp.v(p text) returns uuid language sql as $$ select (value->>'id')::uuid from seen where label=p $$;
create function pg_temp.upload(p_key text, p_content text, p_parent uuid) returns uuid language plpgsql as $$
declare a jsonb;
begin
  a := public.service_admit_space_upload(pg_temp.owner(), jsonb_build_object('teamId',pg_temp.team(),'parentMaterialId',p_parent,
    'name','File '||p_key||'.png','contentType','image/png','bytes','100','contentId',p_content,'ingress','explorer',
    'idempotencyKey',p_key,'category','image','classificationSource','mime','fileExtension','png'));
  if a->>'kind'='exists' then return (a->>'materialId')::uuid; end if;
  perform public.service_attach_space_upload((a->>'uploadId')::uuid, pg_temp.owner(), 'r2-'||p_key);
  perform public.service_mark_space_upload_completing((a->>'uploadId')::uuid, pg_temp.team(), pg_temp.owner(), p_content, repeat('e',32)||'-1');
  return (public.service_complete_space_upload((a->>'uploadId')::uuid, pg_temp.team(), pg_temp.owner(), '{}'::jsonb)->>'id')::uuid;
end $$;
create function pg_temp.usage() returns text language sql as $$
  select coalesce(string_agg(category||'='||bytes||'/'||shared_bytes, ',' order by category),'') from public.space_storage_usage
   where team_id=pg_temp.team() and bytes>0 $$;

insert into seen select 'space', public.service_create_r2_space(pg_temp.owner(),'Attach space','attach-space-key-0001');
with t as (insert into public.team_tasks(team_id,created_by,title) values (pg_temp.team(),pg_temp.owner(),'Brief') returning id)
insert into seen select 'task', jsonb_build_object('id', id) from t;
insert into seen select 'drops', public.service_mutate_space_materials(pg_temp.owner(), pg_temp.team(),
 jsonb_build_object('action','create_folder','name','Task attachments','ensure',true))->'materials'->0;

-- 1. A file from the explorer, attached ----------------------------------------------------
insert into seen select 'explorer', jsonb_build_object('id', pg_temp.upload('explorer-key-00000001', repeat('1',64), pg_temp.root()));
set local role authenticated;
select set_config('request.jwt.claim.sub', '05730000-0000-4000-8000-000000000001', true);
select is(jsonb_array_length(public.attach_team_task_materials(pg_temp.team(), pg_temp.v('task'), array[pg_temp.v('explorer')])->'attached'),
 1,'an R2 file is attached to a task');
reset role;
select is((select category from public.space_object_refs where owner_kind='task_attachment'),'attachments',
 'the attachment references its object as attachments');
select is(pg_temp.usage(),'materials=100/100','the object still counts once, in materials, as shared');
set local role authenticated;
select set_config('request.jwt.claim.sub', '05730000-0000-4000-8000-000000000001', true);
insert into seen select 'detach1', public.detach_task_material_safely(pg_temp.team(), pg_temp.v('task'), pg_temp.v('explorer'));
reset role;
select is((select value->>'state' from seen where label='detach1'),'retained','detaching a file the task did not bring keeps it');
select is((select lifecycle from public.team_materials where id=pg_temp.v('explorer')),'active','the material stays in the explorer');
select ok(not exists(select 1 from public.space_object_refs where owner_kind='task_attachment'),'and the attachment reference is gone');

-- 2. A file the task brought in --------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', '05730000-0000-4000-8000-000000000001', true);
select public.begin_task_upload(pg_temp.team(), pg_temp.v('task'), 'task-drop-key-0000001');
reset role;
insert into seen select 'dropped', jsonb_build_object('id', pg_temp.upload('task-drop-key-0000001', repeat('2',64), pg_temp.v('drops')));
select ok(exists(select 1 from private.task_owned_uploads where material_id=pg_temp.v('dropped') and drive_file_id is null and space_upload_id is not null),
 'the commit records the upload as the task''s own');
select is(pg_temp.usage(),'attachments=100/0,materials=100/0','its bytes count as attachments');
set local role authenticated;
select set_config('request.jwt.claim.sub', '05730000-0000-4000-8000-000000000001', true);
select public.attach_team_task_materials(pg_temp.team(), pg_temp.v('task'), array[pg_temp.v('dropped')]);
insert into seen select 'detach2', public.detach_task_material_safely(pg_temp.team(), pg_temp.v('task'), pg_temp.v('dropped'));
reset role;
select is((select value->>'state' from seen where label='detach2'),'waiting','detaching a task''s own file schedules its cleanup');
select ok(private.task_cleanup_coverage_verified(),'every table that can name a material is still fenced');
select ok(not private.task_cleanup_has_reference(pg_temp.v('dropped'), null),
 'its own upload receipt is not a reference that keeps it');
update private.task_attachment_cleanup set not_before=clock_timestamp()-interval '1 second' where material_id=pg_temp.v('dropped');
select is(public.service_claim_task_cleanup(3),'[]'::jsonb,'no Drive plan is handed out for an R2 file');
select is((select lifecycle from public.team_materials where id=pg_temp.v('dropped'))||':'||
 (select state from private.task_attachment_cleanup where material_id=pg_temp.v('dropped')),'trashed:trashed',
 'it goes to the space''s trash at once');
select is(pg_temp.usage(),'materials=100/0,trash=100/0','and its bytes count as trash');

select * from finish();
rollback;
