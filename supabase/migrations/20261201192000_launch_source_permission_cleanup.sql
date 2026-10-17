-- A source grant can be rolled back only by its exact Drive permission ID.
-- While a deletion is in flight, new catalog intents for the team wait; an
-- already running intent or an unjournaled catalog keeps the outcome pending.
alter table private.catalog_generation_sharing drop constraint if exists catalog_generation_sharing_state_check;
alter table private.catalog_generation_sharing add constraint catalog_generation_sharing_state_check
 check(state in('pending','created','preserved','cleanup_pending','revoking','retained','cleaned'));

create function private.launch_source_grant_start_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and exists(select 1 from public.team_launch_generations g where g.team_id=new.team_id
  and new.request_key='launch:'||g.id::text||':catalog'
  and g.state in('cancel_requested','canceled_with_cleanup_pending','canceled'))
 then return new;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.team_id::text||'launch-source-grant',0));
 if exists(
  select 1 from private.catalog_generation_sharing s
  join private.catalog_generation_intents i on i.id=s.intent_id
  join public.team_launch_generations g on i.request_key='launch:'||g.id::text||':catalog' and g.team_id=i.team_id
  where i.team_id=new.team_id and i.id is distinct from new.id and s.state='revoking'
   and g.state='canceled_with_cleanup_pending' and g.lease_owner is not null
   and g.lease_expires_at>clock_timestamp()
 ) then raise exception 'GROUP_RECONCILING' using errcode='55000';end if;
 return new;
end $$;
create trigger launch_source_grant_start_guard before insert or update of lease_expires_at,checkpoint,state
 on private.catalog_generation_intents for each row execute function private.launch_source_grant_start_guard();
revoke all on function private.launch_source_grant_start_guard() from public,anon,authenticated;

create function public.service_list_launch_cleanup_permissions(
 p_team uuid,p_generation uuid,p_owner uuid,p_fence text,p_intent_fence text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;i private.catalog_generation_intents%rowtype;result jsonb;
begin
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=g.actor_id
  and request_key='launch:'||g.id::text||':catalog';
 if p_owner is null or g.id is null or i.id is null or g.state<>'canceled_with_cleanup_pending'
  or g.lease_owner is distinct from p_owner::text or g.fence::text is distinct from p_fence
  or g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp()
  or i.lease_owner is distinct from p_owner or i.fence::text is distinct from p_intent_fence
  or i.lease_expires_at is null or i.lease_expires_at<=clock_timestamp()
 then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if i.state='registered' or
  (i.checkpoint->>'createStarted'='true' and i.checkpoint->>'launchOutputCleaned' is distinct from 'true')
 then return '[]'::jsonb;end if;
 select coalesce(jsonb_agg(jsonb_build_object('fileId',file_id,'credentialId',credential_id,
  'permissionId',permission_id) order by file_id),'[]'::jsonb) into result
 from (select file_id,credential_id,permission_id from private.catalog_generation_sharing
  where intent_id=i.id and not prior_anyone and created_by_attempt and permission_id is not null
   and state in('created','cleanup_pending','revoking') order by file_id limit 1) grants;
 return result;
end $$;

create function public.service_authorize_launch_permission_cleanup(
 p_team uuid,p_generation uuid,p_owner uuid,p_fence text,p_intent_fence text,
 p_file text,p_credential uuid,p_permission text
) returns text language plpgsql security definer set search_path='' as $$
declare l public.team_launches%rowtype;g public.team_launch_generations%rowtype;
 i private.catalog_generation_intents%rowtype;s private.catalog_generation_sharing%rowtype;
 m public.team_materials%rowtype;
begin
 if p_owner is null or p_file is null or p_permission is null or p_credential is null
  or char_length(p_file) not between 1 and 200 or char_length(p_permission) not between 1 and 200
  or p_file ~ '[[:cntrl:]]' or p_permission ~ '[[:cntrl:]]' then return 'unknown';end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations
  where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=g.actor_id
  and request_key='launch:'||g.id::text||':catalog' for update;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text||'launch-source-grant',0));
 if l.id is null or g.id is null or i.id is null or g.state<>'canceled_with_cleanup_pending'
  or g.lease_owner is distinct from p_owner::text or g.fence::text is distinct from p_fence
  or g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp()
  or i.lease_owner is distinct from p_owner or i.fence::text is distinct from p_intent_fence
  or i.lease_expires_at is null or i.lease_expires_at<=clock_timestamp()
 then return 'unknown';end if;
 if i.state='registered' then return 'retained';end if;
 if i.checkpoint->>'createStarted'='true' and i.checkpoint->>'launchOutputCleaned' is distinct from 'true'
 then return 'unknown';end if;
 select * into s from private.catalog_generation_sharing where intent_id=i.id and file_id=p_file for update;
 if s.intent_id is null or s.credential_id<>p_credential or s.permission_id is distinct from p_permission
  or s.prior_anyone or not s.created_by_attempt or s.state not in('created','cleanup_pending','revoking')
 then return 'unknown';end if;
 select * into m from public.team_materials where team_id=p_team and drive_file_id=p_file;
 if m.id is null or m.category not in('video','image') then return 'unknown';end if;
 if m.category='video' and m.id<>i.video_material_id then return 'unknown';end if;
 if m.category='image' and not exists(
  select 1 from jsonb_array_elements(coalesce(i.checkpoint->'images','[]'::jsonb)) image
  where image->>'driveFileId'=p_file
 ) then return 'unknown';end if;
 if exists(select 1 from private.catalog_generation_intents other
  where other.team_id=p_team and other.id<>i.id and other.state not in('canceled','registered')
   and (other.video_material_id=m.id or exists(
    select 1 from jsonb_array_elements(coalesce(other.checkpoint->'images','[]'::jsonb)) image
    where image->>'driveFileId'=p_file)))
  or exists(select 1 from private.catalog_generation_sharing other_share
   join private.catalog_generation_intents other on other.id=other_share.intent_id
   where other.team_id=p_team and other.id<>i.id and other.state not in('canceled','registered')
    and other_share.file_id=p_file and other_share.state<>'cleaned')
  or (m.category='image' and exists(select 1 from public.team_product_catalogs c
   where c.team_id=p_team and not exists(select 1 from private.catalog_generation_intents known
    where known.team_id=p_team and known.state='registered'
     and known.result->'catalog'->>'materialId'=c.material_id::text
     and known.checkpoint ? 'images')))
 then return 'unknown';end if;
 if exists(select 1 from private.catalog_generation_intents other
  where other.team_id=p_team and other.id<>i.id and other.state='registered'
   and (other.video_material_id=m.id or exists(
    select 1 from jsonb_array_elements(coalesce(other.checkpoint->'images','[]'::jsonb)) image
    where image->>'driveFileId'=p_file)))
  or exists(select 1 from private.catalog_generation_sharing other_share
   join private.catalog_generation_intents other on other.id=other_share.intent_id
   where other.team_id=p_team and other.id<>i.id and other.state='registered'
    and other_share.file_id=p_file and other_share.state<>'cleaned')
  or (m.category='video' and exists(select 1 from public.team_product_catalogs c
   where c.team_id=p_team and c.video_material_id=m.id))
 then return 'retained';end if;
 update private.catalog_generation_sharing set state='revoking',updated_at=clock_timestamp()
  where intent_id=i.id and file_id=p_file;
 return 'owned_unpublished';
end $$;

create function public.service_mark_launch_permission_cleaned(
 p_team uuid,p_generation uuid,p_owner uuid,p_fence text,p_intent_fence text,
 p_file text,p_credential uuid,p_permission text
) returns void language plpgsql security definer set search_path='' as $$
declare i uuid;
begin
 if public.service_authorize_launch_permission_cleanup(p_team,p_generation,p_owner,p_fence,
  p_intent_fence,p_file,p_credential,p_permission) is distinct from 'owned_unpublished'
 then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 select id into i from private.catalog_generation_intents where team_id=p_team
  and request_key='launch:'||p_generation::text||':catalog';
 update private.catalog_generation_sharing set state='cleaned',updated_at=clock_timestamp()
  where intent_id=i and file_id=p_file and credential_id=p_credential and permission_id=p_permission
   and state='revoking';
 if not found then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
end $$;
create function public.service_mark_launch_permission_retained(
 p_team uuid,p_generation uuid,p_owner uuid,p_fence text,p_intent_fence text,
 p_file text,p_credential uuid,p_permission text
) returns void language plpgsql security definer set search_path='' as $$
declare i uuid;
begin
 if public.service_authorize_launch_permission_cleanup(p_team,p_generation,p_owner,p_fence,
  p_intent_fence,p_file,p_credential,p_permission) is distinct from 'retained'
 then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 select id into i from private.catalog_generation_intents where team_id=p_team
  and request_key='launch:'||p_generation::text||':catalog';
 update private.catalog_generation_sharing set state='retained',updated_at=clock_timestamp()
  where intent_id=i and file_id=p_file and credential_id=p_credential and permission_id=p_permission
   and state in('created','cleanup_pending','revoking');
 if not found then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
end $$;
revoke all on function public.service_list_launch_cleanup_permissions(uuid,uuid,uuid,text,text),
 public.service_authorize_launch_permission_cleanup(uuid,uuid,uuid,text,text,text,uuid,text),
 public.service_mark_launch_permission_cleaned(uuid,uuid,uuid,text,text,text,uuid,text),
 public.service_mark_launch_permission_retained(uuid,uuid,uuid,text,text,text,uuid,text)
 from public,anon,authenticated;
grant execute on function public.service_list_launch_cleanup_permissions(uuid,uuid,uuid,text,text),
 public.service_authorize_launch_permission_cleanup(uuid,uuid,uuid,text,text,text,uuid,text),
 public.service_mark_launch_permission_cleaned(uuid,uuid,uuid,text,text,text,uuid,text),
 public.service_mark_launch_permission_retained(uuid,uuid,uuid,text,text,text,uuid,text)
 to service_role;

-- A grant deliberately retained for a proven registered consumer is resolved.
-- Pending/unknown grants still prevent cancellation settlement.
create or replace function public.service_finish_launch_cleanup(p_team uuid,p_generation uuid,p_owner uuid,p_fence text,p_intent_fence text,p_cleaned_file text default null) returns text
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;i private.catalog_generation_intents%rowtype;settled boolean;
begin
 if p_owner is null or p_fence is null or p_intent_fence is null then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=g.actor_id and request_key='launch:'||g.id::text||':catalog' for update;
 if g.id is null or i.id is null or g.state is distinct from 'canceled_with_cleanup_pending' or g.lease_owner is distinct from p_owner::text or g.fence::text is distinct from p_fence or (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
  or i.lease_owner is distinct from p_owner or i.fence::text is distinct from p_intent_fence or (i.lease_expires_at is null or i.lease_expires_at<=clock_timestamp()) then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if p_cleaned_file is not null then
  if public.service_authorize_launch_cleanup(p_team,p_generation,p_owner,p_fence,p_intent_fence,p_cleaned_file) is distinct from 'owned_unpublished' then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
  update private.catalog_generation_intents set checkpoint=checkpoint||'{"launchOutputCleaned":true}',updated_at=clock_timestamp() where id=i.id returning * into i;
  update private.catalog_generation_sharing set state='cleaned',updated_at=clock_timestamp()
   where intent_id=i.id and file_id=p_cleaned_file and state<>'cleaned';
 end if;
 settled:=i.state='registered' or
  ((i.checkpoint->>'createStarted' is distinct from 'true' or i.checkpoint->>'launchOutputCleaned'='true')
   and not exists(select 1 from private.catalog_generation_sharing s where s.intent_id=i.id and not s.prior_anyone
    and s.state not in('cleaned','retained') and (s.created_by_attempt or s.state in('pending','cleanup_pending','revoking'))));
 if settled and i.state<>'registered' then update private.catalog_generation_intents set state='canceled',lease_expires_at=null,next_attempt_at=null,updated_at=clock_timestamp() where id=i.id;end if;
 update public.team_launch_generations set state=case when settled then 'canceled' else 'canceled_with_cleanup_pending' end,
  stage=case when settled then 'cancel' else 'cleanup' end,state_version=state_version+1,lease_owner=null,lease_expires_at=null,
  next_attempt_at=case when settled then null else clock_timestamp()+interval '5 minutes' end,
  safe_error_code=case when settled then null else 'LAUNCH_RESULT_UNCERTAIN' end,updated_at=clock_timestamp() where id=g.id;
 update private.catalog_generation_intents set lease_expires_at=clock_timestamp(),next_attempt_at=case when settled then null else clock_timestamp()+interval '5 minutes' end where id=i.id;
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);
 return case when settled then 'canceled' else 'canceled_with_cleanup_pending' end;
end $$;
