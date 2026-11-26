begin;
select plan(27);
-- Production 2026-11-26: a launch cancelled right after its catalog sheet was created never left
-- canceled_with_cleanup_pending once the sheet had become a file of the space, and could not be
-- deleted either. (20261224390000)
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c1740000-0000-4000-8000-000000000001','authenticated','authenticated','cleanup-kept@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c1740000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values('c1740000-0000-4000-8000-000000000011','Synthetic kept output','c1740000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c1740000-0000-4000-8000-000000000011','c1740000-0000-4000-8000-000000000001','admin') on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('c1740000-0000-4000-8000-000000000021','c1740000-0000-4000-8000-000000000001','cleanup-kept','cleanup-kept@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('c1740000-0000-4000-8000-000000000031','c1740000-0000-4000-8000-000000000011','c1740000-0000-4000-8000-000000000021','kept-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,drive_version,checksum) values
 ('c1740000-0000-4000-8000-000000000041','c1740000-0000-4000-8000-000000000011','c1740000-0000-4000-8000-000000000031','kept-video','kept-root','Video.mp4','file','video','video/mp4','1',repeat('c',32));

-- One launch per case, each cancelled while its catalog was being registered: the generation is
-- cancel_requested and due, its catalog intent is finalized with the sheet created.
--  1 the sheet is an active file of the space        2 the sheet is in the space's bin
--  3 the sheet is not a file of the space (control)  4 kept sheet, but a link this attempt opened is still open
--  5 still running (control for deletion)
create function pg_temp.launch(n integer,p_state text default 'cancel_requested') returns void language plpgsql as $$
declare launch uuid:=('c1740000-0000-4000-8000-00000000010'||n)::uuid;revision uuid:=('c1740000-0000-4000-8000-00000000020'||n)::uuid;
 generation uuid:=('c1740000-0000-4000-8000-00000000030'||n)::uuid;intent uuid:=('c1740000-0000-4000-8000-00000000040'||n)::uuid;
begin
 insert into public.team_launches(id,team_id,created_by,draft_config) values(launch,'c1740000-0000-4000-8000-000000000011','c1740000-0000-4000-8000-000000000001','{}');
 insert into public.team_launch_revisions(id,team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)
  values(revision,'c1740000-0000-4000-8000-000000000011',launch,1,'generated','{"method":"catalog","catalog":{}}','{"materialType":"video"}',
   'https://offer.example.invalid/','https://offer.example.invalid/?s=1','{}','c1740000-0000-4000-8000-000000000001');
 insert into public.team_launch_generations(id,team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state,stage,lease_owner,lease_expires_at,next_attempt_at)
  values(generation,'c1740000-0000-4000-8000-000000000011',launch,revision,'c1740000-0000-4000-8000-000000000001','kept-generation-'||n,'digest','v1',
   p_state,'catalog_registering',null,null,null);
 insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint,lease_owner,lease_expires_at)
  values(intent,'c1740000-0000-4000-8000-000000000011','c1740000-0000-4000-8000-000000000041','c1740000-0000-4000-8000-000000000001',
   'launch:'||generation::text||':catalog','digest-'||n,'{}',n,'finalized',
   jsonb_build_object('createStarted',true,'providerFileId','kept-sheet-'||n,'parentId','kept-root','credentialId','c1740000-0000-4000-8000-000000000021'),
   'c1740000-0000-4000-8000-000000000901',clock_timestamp()-interval '1 minute');
 -- The video's link was public before the launch: nothing of this attempt's to close.
 insert into private.catalog_generation_sharing(intent_id,file_id,credential_id,permission_id,prior_anyone,created_by_attempt,state)
  values(intent,'kept-video','c1740000-0000-4000-8000-000000000021',null,true,false,'preserved');
end $$;
select pg_temp.launch(1);select pg_temp.launch(2);select pg_temp.launch(3);select pg_temp.launch(4);select pg_temp.launch(5,'running');
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,drive_version,lifecycle,trashed_at) values
 ('c1740000-0000-4000-8000-000000000051','c1740000-0000-4000-8000-000000000011','c1740000-0000-4000-8000-000000000031','kept-sheet-1','kept-root','Catalog 1','file','other','application/vnd.google-apps.spreadsheet','1','active',null),
 ('c1740000-0000-4000-8000-000000000052','c1740000-0000-4000-8000-000000000011','c1740000-0000-4000-8000-000000000031','kept-sheet-2','kept-root','Catalog 2','file','other','application/vnd.google-apps.spreadsheet','1','trashed',now()),
 ('c1740000-0000-4000-8000-000000000054','c1740000-0000-4000-8000-000000000011','c1740000-0000-4000-8000-000000000031','kept-sheet-4','kept-root','Catalog 4','file','other','application/vnd.google-apps.spreadsheet','1','active',null);
insert into private.catalog_generation_sharing(intent_id,file_id,credential_id,permission_id,prior_anyone,created_by_attempt,state)
 values('c1740000-0000-4000-8000-000000000404','kept-source-4','c1740000-0000-4000-8000-000000000021','grant-4',false,true,'created');

-- One cleanup tick: the claim, then the finish the worker calls when there was nothing to remove.
create temp table tick(n integer primary key,plan jsonb,outcome text);
create function pg_temp.tick() returns void language plpgsql as $$
declare plans jsonb;p jsonb;n integer;
begin
 delete from tick;
 plans:=public.service_claim_launch_cleanup('c1740000-0000-4000-8000-000000000902',10);
 for p in select value from jsonb_array_elements(plans) loop
  if p->>'generationId' not like 'c1740000-0000-4000-8000-00000000030_' then continue;end if;
  n:=right(p->>'generationId',1)::integer;
  insert into tick values(n,p,public.service_finish_launch_cleanup((p->>'teamId')::uuid,(p->>'generationId')::uuid,
   'c1740000-0000-4000-8000-000000000902',p->>'fence',p->>'intentFence',null));
 end loop;
end $$;
create function pg_temp.gen(n integer) returns text language sql as $$
 select state||':'||stage||':'||coalesce(safe_error_code,'-') from public.team_launch_generations where id=('c1740000-0000-4000-8000-00000000030'||n)::uuid;
$$;
select pg_temp.tick();
select is((select array_agg(n order by n) from tick),array[1,2,3,4],'the tick takes the four cancelled launches and leaves the running one');
select is((select jsonb_array_length(plan->'outputs') from tick where n=1),0,'a sheet that is a file of the space is never offered for removal');
select is((select jsonb_array_length(plan->'outputs') from tick where n=2),0,'nor is one in the space''s bin');
select is((select plan->'outputs'->0->>'fileId' from tick where n=3),'kept-sheet-3','a sheet the space does not hold is offered for removal');

select is((select outcome from tick where n=1),'canceled','a kept sheet closes the cleanup at once');
select is(pg_temp.gen(1),'canceled:cancel:-','the generation is cancelled, with no error left on it');
select is((select state from private.catalog_generation_intents where id='c1740000-0000-4000-8000-000000000401'),'canceled','its catalog intent is closed');
select is((select checkpoint->>'launchOutputRetained' from private.catalog_generation_intents where id='c1740000-0000-4000-8000-000000000401'),'true','the checkpoint says the output was kept');
select ok((select not checkpoint ? 'launchOutputCleaned' from private.catalog_generation_intents where id='c1740000-0000-4000-8000-000000000401'),'and does not claim it was removed');
select ok((select lifecycle='active' from public.team_materials where id='c1740000-0000-4000-8000-000000000051'),'the sheet stays in the space');
select is((select state from private.catalog_generation_sharing where intent_id='c1740000-0000-4000-8000-000000000401'),'preserved','a link that was public before is left as it was');

select is((select outcome from tick where n=2),'canceled','a sheet in the bin closes the cleanup too');
select is(pg_temp.gen(2),'canceled:cancel:-','that generation is cancelled as well');

select is((select outcome from tick where n=3),'canceled_with_cleanup_pending','a created sheet that is neither kept nor removed keeps the cleanup open');
select is(pg_temp.gen(3),'canceled_with_cleanup_pending:cleanup:LAUNCH_RESULT_UNCERTAIN','as before');
select ok((select next_attempt_at>clock_timestamp()+interval '4 minutes' from public.team_launch_generations where id='c1740000-0000-4000-8000-000000000303'),'and it is tried again in five minutes');
select ok((select not checkpoint ?| array['launchOutputRetained','launchOutputCleaned'] from private.catalog_generation_intents where id='c1740000-0000-4000-8000-000000000403'),'nothing is marked on its checkpoint');

select is((select outcome from tick where n=4),'canceled_with_cleanup_pending','a link this attempt opened still holds the cleanup, kept sheet or not');
update private.catalog_generation_sharing set state='cleaned' where intent_id='c1740000-0000-4000-8000-000000000404' and file_id='kept-source-4';

-- Deleting. The person can delete a cancelled launch whose leftovers are still being removed.
set local request.jwt.claim.sub = 'c1740000-0000-4000-8000-000000000001';
create function pg_temp.archive(n integer) returns jsonb language sql as $$
 select public.archive_launch('c1740000-0000-4000-8000-000000000011',('c1740000-0000-4000-8000-00000000010'||n)::uuid,
  (select aggregate_version::text from public.team_launches where id=('c1740000-0000-4000-8000-00000000010'||n)::uuid),'kept-archive-key-'||n,false);
$$;
select throws_ok($$select pg_temp.archive(5)$$,'55000','LAUNCH_BUSY','a launch that is still generating cannot be deleted');
update public.team_launch_generations set state='cancel_requested' where id='c1740000-0000-4000-8000-000000000305';
select throws_ok($$select pg_temp.archive(5)$$,'55000','LAUNCH_BUSY','nor one whose cancellation has not been taken up yet');
select lives_ok($$select pg_temp.archive(3)$$,'a cancelled launch still cleaning up can be deleted');
select ok((select archived_at is not null from public.team_launches where id='c1740000-0000-4000-8000-000000000103'),'it is gone from the list');
select is(pg_temp.gen(3),'canceled_with_cleanup_pending:cleanup:LAUNCH_RESULT_UNCERTAIN','its cleanup is still owed');

-- The cleanup of the deleted launch carries on and closes once the sheet turns out to be kept.
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,drive_version) values
 ('c1740000-0000-4000-8000-000000000053','c1740000-0000-4000-8000-000000000011','c1740000-0000-4000-8000-000000000031','kept-sheet-3','kept-root','Catalog 3','file','other','application/vnd.google-apps.spreadsheet','1');
update public.team_launch_generations set next_attempt_at=clock_timestamp()-interval '1 second' where id in('c1740000-0000-4000-8000-000000000303','c1740000-0000-4000-8000-000000000304');
update private.catalog_generation_intents set lease_expires_at=clock_timestamp()-interval '1 second',next_attempt_at=null where id in('c1740000-0000-4000-8000-000000000403','c1740000-0000-4000-8000-000000000404');
select pg_temp.tick();
select is((select outcome from tick where n=3),'canceled','the deleted launch''s cleanup closes on the next tick');
select is((select outcome from tick where n=4),'canceled','and so does the one whose opened link has been closed');
select is((select array_agg(state order by id) from public.team_launch_generations where team_id='c1740000-0000-4000-8000-000000000011' and id<>'c1740000-0000-4000-8000-000000000305'),
 array['canceled','canceled','canceled','canceled'],'none of the four is left waiting');
select is(pg_temp.gen(5),'canceled_with_cleanup_pending:cleanup:LAUNCH_RESULT_UNCERTAIN','a cancelled launch whose created sheet nobody holds still waits for its removal');
select * from finish();
rollback;
