begin;
select plan(9);
-- 20261224380000: the walk below «Soty cache» needs the children of a folder whatever their
-- lifecycle. The index must stay complete (not partial), and what the search hides must not move.
select ok(exists(
 select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
 where c.relname='team_materials_children_idx' and i.indrelid='public.team_materials'::regclass
   and i.indisvalid and i.indisready and not i.indisunique and i.indpred is null and i.indexprs is null
   and (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::smallint[]) with ordinality as k(attnum,ord)
        join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum)=array['team_id','connection_id','parent_folder_id']
),'the children of a folder are indexed for every lifecycle');

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c1730000-0000-4000-8000-000000000001','authenticated','authenticated','children-index@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c1730000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values('c1730000-0000-4000-8000-000000000011','Synthetic cache walk','c1730000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c1730000-0000-4000-8000-000000000011','c1730000-0000-4000-8000-000000000001','admin') on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
 values('c1730000-0000-4000-8000-000000000021','c1730000-0000-4000-8000-000000000001','children-index','children-index@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
 values('c1730000-0000-4000-8000-000000000031','c1730000-0000-4000-8000-000000000011','c1730000-0000-4000-8000-000000000021','walk-root','Synthetic root','my_drive','connected',now());
-- root
--  ├─ walkprobe-visible.mp4
--  ├─ Soty cache            (folder)
--  │   ├─ walkprobe-direct.png
--  │   ├─ kept              (folder, active)   └─ walkprobe-kept.png
--  │   ├─ gone              (folder, missing)  └─ walkprobe-under-missing.png
--  │   └─ binned            (folder, trashed)  └─ walkprobe-under-trashed.png
--  └─ .soty                 (folder)           └─ walkprobe-dot.png
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version,lifecycle,trashed_at,missing_at) values
 ('c1730000-0000-4000-8000-000000000041','c1730000-0000-4000-8000-000000000011','c1730000-0000-4000-8000-000000000031','walk-visible','walk-root','walkprobe-visible.mp4','file','video','video/mp4',4,repeat('c',32),'1','active',null,null),
 ('c1730000-0000-4000-8000-000000000042','c1730000-0000-4000-8000-000000000011','c1730000-0000-4000-8000-000000000031','walk-cache','walk-root','Soty cache','folder',null,'application/vnd.google-apps.folder',null,null,'1','active',null,null),
 ('c1730000-0000-4000-8000-000000000043','c1730000-0000-4000-8000-000000000011','c1730000-0000-4000-8000-000000000031','walk-direct','walk-cache','walkprobe-direct.png','file','image','image/png',4,repeat('a',32),'1','active',null,null),
 ('c1730000-0000-4000-8000-000000000044','c1730000-0000-4000-8000-000000000011','c1730000-0000-4000-8000-000000000031','walk-kept','walk-cache','kept','folder',null,'application/vnd.google-apps.folder',null,null,'1','active',null,null),
 ('c1730000-0000-4000-8000-000000000045','c1730000-0000-4000-8000-000000000011','c1730000-0000-4000-8000-000000000031','walk-kept-file','walk-kept','walkprobe-kept.png','file','image','image/png',4,repeat('b',32),'1','active',null,null),
 ('c1730000-0000-4000-8000-000000000046','c1730000-0000-4000-8000-000000000011','c1730000-0000-4000-8000-000000000031','walk-gone','walk-cache','gone','folder',null,'application/vnd.google-apps.folder',null,null,'1','missing',null,now()),
 ('c1730000-0000-4000-8000-000000000047','c1730000-0000-4000-8000-000000000011','c1730000-0000-4000-8000-000000000031','walk-gone-file','walk-gone','walkprobe-under-missing.png','file','image','image/png',4,repeat('d',32),'1','active',null,null),
 ('c1730000-0000-4000-8000-000000000048','c1730000-0000-4000-8000-000000000011','c1730000-0000-4000-8000-000000000031','walk-binned','walk-cache','binned','folder',null,'application/vnd.google-apps.folder',null,null,'1','trashed',now(),null),
 ('c1730000-0000-4000-8000-000000000049','c1730000-0000-4000-8000-000000000011','c1730000-0000-4000-8000-000000000031','walk-binned-file','walk-binned','walkprobe-under-trashed.png','file','image','image/png',4,repeat('e',32),'1','active',null,null),
 ('c1730000-0000-4000-8000-00000000004a','c1730000-0000-4000-8000-000000000011','c1730000-0000-4000-8000-000000000031','walk-dot','walk-root','.soty','folder',null,'application/vnd.google-apps.folder',null,null,'1','active',null,null),
 ('c1730000-0000-4000-8000-00000000004b','c1730000-0000-4000-8000-000000000011','c1730000-0000-4000-8000-000000000031','walk-dot-file','walk-dot','walkprobe-dot.png','file','image','image/png',4,repeat('f',32),'1','active',null,null);

create function pg_temp.names(p_query text,p_parent text default null,p_recursive boolean default false) returns text[] language sql as $$
 select coalesce(array_agg(item->>'name' order by item->>'name'),'{}')
 from jsonb_array_elements(public.search_materials('c1730000-0000-4000-8000-000000000011',p_query,'{}'::jsonb,1,50,p_parent,null,p_recursive)->'items') item;
$$;
create function pg_temp.total(p_query text,p_parent text default null,p_recursive boolean default false) returns integer language sql as $$
 select (public.search_materials('c1730000-0000-4000-8000-000000000011',p_query,'{}'::jsonb,1,50,p_parent,null,p_recursive)->>'total')::integer;
$$;
-- The search answers its caller: auth.uid() reads this claim.
set local request.jwt.claim.sub = 'c1730000-0000-4000-8000-000000000001';
select is(pg_temp.names('walkprobe'),array['walkprobe-visible.mp4'],'a query finds only the file outside the cache');
select is(pg_temp.total('walkprobe'),1,'the total counts only that file');
select is(pg_temp.total(null),1,'browsing without a query hides the cache folders and everything below them');
select is(pg_temp.names(null),array['walkprobe-visible.mp4'],'and lists only the file outside the cache');
select is(pg_temp.total('walkprobe','walk-cache',true),0,'nothing is found below the cache folder itself');
select is(pg_temp.total('walkprobe','walk-root',true),1,'a search below the root still finds the one visible file');
-- The walk goes through folders that are no longer active: the files below them stay hidden.
select ok(not pg_temp.names('walkprobe') && array['walkprobe-under-missing.png','walkprobe-under-trashed.png'],'a missing or trashed folder in the middle does not let its files back in');
-- The plan-cache mode a pooled PostgREST connection ends up in: the answer is the same.
set local plan_cache_mode = force_generic_plan;
select is(pg_temp.names('walkprobe'),array['walkprobe-visible.mp4'],'the generic plan gives the same answer');
select * from finish();
rollback;
