-- Resumable full-source integrity. Private, service-only; no public content is exposed.
-- Drain legacy copy invocations before qualifying this worker protocol (see 050 review).
create table private.catalog_video_r2_verification (
 copy_id uuid primary key references private.catalog_video_r2_copies(id) on delete cascade,
 staging_etag text not null check(staging_etag ~ '^"[!#-~]{1,200}"$'),
 manifest jsonb not null check(jsonb_typeof(manifest)='array'),
 source_md5 text not null check(source_md5 ~ '^[0-9a-f]{32}$'),
 parts_checked integer not null default 0 check(parts_checked>=0),
 bytes_checked bigint not null default 0 check(bytes_checked>=0),
 hash_state jsonb,
 final_md5 text check(final_md5 is null or final_md5 ~ '^[0-9a-f]{32}$'),
 updated_at timestamptz not null default clock_timestamp()
);
-- No FK: cleanup must survive deletion. This obligation can ONLY remove private staging.
create table private.catalog_video_r2_staging_cleanup (
 copy_id uuid primary key,
 team_id uuid,
 object_key text not null unique,
 staging_etag text not null,
 fence bigint not null default 0,
 lease_until timestamptz,
 attempts integer not null default 0,
 next_attempt_at timestamptz not null default clock_timestamp(),
 cleaned_at timestamptz,
 last_error text,
 created_at timestamptz not null default clock_timestamp()
);
create index catalog_video_r2_staging_cleanup_due on private.catalog_video_r2_staging_cleanup(next_attempt_at) where cleaned_at is null;
alter table private.catalog_video_r2_verification enable row level security;
alter table private.catalog_video_r2_verification force row level security;
alter table private.catalog_video_r2_staging_cleanup enable row level security;
alter table private.catalog_video_r2_staging_cleanup force row level security;
revoke all on private.catalog_video_r2_verification,private.catalog_video_r2_staging_cleanup from public,anon,authenticated,service_role;

-- Every catalog reference participates in the shared cleanup admission fence.
-- Omitting one disables safe cleanup across the whole workspace.
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_r2_verification for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_r2_staging_cleanup for each row execute function private.guard_task_cleanup_reference();

-- A ready acknowledgement may be lost after committing its cleanup obligation.
-- The scheduler must discover that obligation even when no copy needs other work.
create or replace function private.catalog_video_r2_has_work(p_route text) returns boolean language sql stable security definer set search_path='' as $$
 select case when p_route='claim' then exists(select 1 from private.catalog_video_r2_config where enabled) and exists(select 1 from private.catalog_video_r2_copies where state in ('planned','uploading','verifying') and next_attempt_at<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp()))
  else exists(select 1 from private.catalog_video_r2_copies where state='retiring' and retire_after<=clock_timestamp())
   or exists(select 1 from private.catalog_video_r2_copies c where c.state='ready' and not exists(select 1 from private.catalog_video_r2_uses u where u.copy_id=c.id) and c.ready_at<clock_timestamp()-(select grace_interval from private.catalog_video_r2_config))
   or exists(select 1 from private.catalog_video_r2_purges where purged_at is null and next_attempt_at<=clock_timestamp() and attempts<64)
   or exists(select 1 from private.catalog_video_r2_staging_cleanup where cleaned_at is null and next_attempt_at<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp())) end
$$;

create function private.catalog_video_r2_manifest(p_copy uuid) returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('partNumber',part_number,'sizeBytes',size_bytes,'sha256',sha256,'etag',etag,'verifiedBy',verified_by) order by part_number),'[]'::jsonb)
 from private.catalog_video_r2_parts where copy_id=p_copy
$$;

create function public.service_catalog_video_r2_verification_open(p_copy uuid,p_worker text,p_fence bigint,p_etag text,p_manifest jsonb,p_source_md5 text) returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype; v private.catalog_video_r2_verification%rowtype; manifest jsonb;
begin
 select * into c from private.catalog_video_r2_copies where id=p_copy and lease_owner=p_worker and fence=p_fence and lease_until>clock_timestamp() and state='verifying' for update;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 manifest:=private.catalog_video_r2_manifest(p_copy);
 if p_manifest is distinct from manifest or p_etag is null or p_etag !~ '^"[!#-~]{1,200}"$' or p_source_md5 is null or p_source_md5 !~ '^[0-9a-f]{32}$' or (c.source_md5 is not null and c.source_md5<>p_source_md5) then raise exception 'VIDEO_R2_CHECKSUM_MISMATCH'; end if;
 if jsonb_array_length(manifest)<>ceil(c.size_bytes::numeric/c.part_bytes) or exists(select 1 from private.catalog_video_r2_parts p where p.copy_id=c.id and p.size_bytes<>least(c.part_bytes,c.size_bytes-(p.part_number-1)::bigint*c.part_bytes)) or (select sum(size_bytes) from private.catalog_video_r2_parts where copy_id=c.id)<>c.size_bytes then raise exception 'VIDEO_R2_CHECKSUM_MISMATCH'; end if;
 update private.catalog_video_r2_copies set source_md5=p_source_md5 where id=p_copy and source_md5 is null;
 insert into private.catalog_video_r2_verification(copy_id,staging_etag,manifest,source_md5) values(p_copy,p_etag,manifest,p_source_md5) on conflict(copy_id) do nothing;
 select * into v from private.catalog_video_r2_verification where copy_id=p_copy;
 if v.staging_etag<>p_etag or v.manifest<>manifest or v.source_md5<>p_source_md5 then raise exception 'VIDEO_R2_CHECKSUM_MISMATCH'; end if;
 return jsonb_build_object('partsChecked',v.parts_checked,'bytesChecked',v.bytes_checked,'hashState',v.hash_state,'finalMd5',v.final_md5);
end $$;

create function public.service_catalog_video_r2_verification_advance(p_copy uuid,p_worker text,p_fence bigint,p_etag text,p_manifest jsonb,p_previous_parts integer,p_hash_state jsonb,p_final_md5 text default null) returns void language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype; v private.catalog_video_r2_verification%rowtype; expected_bytes bigint; last_part boolean;
begin
 select * into c from private.catalog_video_r2_copies where id=p_copy and lease_owner=p_worker and fence=p_fence and lease_until>clock_timestamp() and state='verifying' for update;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 select * into v from private.catalog_video_r2_verification where copy_id=p_copy for update;
 if not found or v.parts_checked is distinct from p_previous_parts or v.staging_etag is distinct from p_etag or v.manifest is distinct from p_manifest or v.manifest<>private.catalog_video_r2_manifest(p_copy) or v.source_md5 is distinct from c.source_md5 or v.final_md5 is not null then raise exception 'LEASE_MISMATCH'; end if;
 select coalesce(sum(size_bytes),0) into expected_bytes from private.catalog_video_r2_parts where copy_id=p_copy and part_number<=p_previous_parts+1;
 last_part:=p_previous_parts+1=jsonb_array_length(v.manifest);
 if expected_bytes<=v.bytes_checked or p_hash_state is null or jsonb_typeof(p_hash_state)<>'object' or (p_hash_state->>'version') is distinct from '1' or (p_hash_state->>'bytes') is distinct from expected_bytes::text or jsonb_typeof(p_hash_state->'state') is distinct from 'array' or jsonb_typeof(p_hash_state->'tail') is distinct from 'array' then raise exception 'INVALID_INPUT'; end if;
 if jsonb_array_length(p_hash_state->'state')<>4 or jsonb_array_length(p_hash_state->'tail')<>mod(expected_bytes,64) or pg_column_size(p_hash_state)>4096 then raise exception 'INVALID_INPUT'; end if;
 if exists(select 1 from jsonb_array_elements(p_hash_state->'state') x where jsonb_typeof(x)<>'number' or x::text !~ '^[0-9]+$' or (x::text)::numeric>4294967295) or exists(select 1 from jsonb_array_elements(p_hash_state->'tail') x where jsonb_typeof(x)<>'number' or x::text !~ '^[0-9]+$' or (x::text)::numeric>255) then raise exception 'INVALID_INPUT'; end if;
 if (last_part and p_final_md5 is distinct from v.source_md5) or (not last_part and p_final_md5 is not null) then raise exception 'VIDEO_R2_CHECKSUM_MISMATCH'; end if;
 update private.catalog_video_r2_verification set parts_checked=p_previous_parts+1,bytes_checked=expected_bytes,hash_state=p_hash_state,final_md5=p_final_md5,updated_at=clock_timestamp() where copy_id=p_copy;
 update private.catalog_video_r2_copies set attempts=0,lease_until=clock_timestamp()+interval '90 seconds' where id=p_copy;
end $$;

create or replace function public.service_catalog_video_r2_ready(p_copy uuid,p_worker text,p_fence bigint,p_full_hash_verified boolean,p_duration_ms bigint default null) returns void language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype; v private.catalog_video_r2_verification%rowtype;
begin
 select * into c from private.catalog_video_r2_copies where id=p_copy and lease_owner=p_worker and fence=p_fence and lease_until>clock_timestamp() and state='verifying' for update;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 select * into v from private.catalog_video_r2_verification where copy_id=p_copy;
 if not found or p_full_hash_verified is distinct from true or v.final_md5 is distinct from c.source_md5 or v.final_md5 is null or v.bytes_checked<>c.size_bytes or v.parts_checked<>jsonb_array_length(v.manifest) or v.manifest<>private.catalog_video_r2_manifest(p_copy) then raise exception 'VIDEO_R2_CHECKSUM_MISMATCH'; end if;
 update private.catalog_video_r2_copies set state='ready',ready_at=clock_timestamp(),full_hash_verified=true,upload_id=null,lease_owner=null,lease_until=null,last_error=null,next_attempt_at=clock_timestamp() where id=p_copy;
 insert into private.catalog_video_r2_staging_cleanup(copy_id,team_id,object_key,staging_etag) values(c.id,c.team_id,c.object_key,v.staging_etag) on conflict(copy_id) do nothing;
 perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'ready',null,'r2',null,c.size_bytes,p_duration_ms,true);
 if c.requested_by_catalog is not null then perform private.catalog_video_r2_signal(c.requested_by_catalog); end if;
end $$;

create or replace function public.service_catalog_video_r2_part(p_copy uuid,p_worker text,p_fence bigint,p_part integer,p_size integer,p_sha256 text,p_etag text,p_verified_by text,p_duration_ms bigint default null) returns void language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype; inserted integer;
begin
 if p_verified_by not in ('provider_checksum','readback') then raise exception 'INVALID_INPUT'; end if;
 select * into c from private.catalog_video_r2_copies where id=p_copy and lease_owner=p_worker and fence=p_fence and lease_until>clock_timestamp() and state='uploading' for update;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 if p_part is null or p_part<1 or p_part>ceil(c.size_bytes::numeric/c.part_bytes) or p_size is distinct from least(c.part_bytes,c.size_bytes-(p_part-1)::bigint*c.part_bytes) then raise exception 'INVALID_INPUT'; end if;
 insert into private.catalog_video_r2_parts(copy_id,part_number,size_bytes,sha256,etag,verified_by) values(p_copy,p_part,p_size,lower(p_sha256),p_etag,p_verified_by) on conflict(copy_id,part_number) do nothing;
 get diagnostics inserted=row_count;
 if not exists(select 1 from private.catalog_video_r2_parts where copy_id=p_copy and part_number=p_part and size_bytes=p_size and sha256=lower(p_sha256) and etag=p_etag and verified_by=p_verified_by) then raise exception 'VIDEO_R2_CHECKSUM_MISMATCH'; end if;
 update private.catalog_video_r2_copies set attempts=case when inserted=1 then 0 else attempts end,lease_until=clock_timestamp()+interval '90 seconds' where id=p_copy;
 if inserted=1 then perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'part_verified',null,null,p_verified_by,p_size,p_duration_ms); end if;
end $$;

create function public.service_catalog_video_r2_claim_staging_cleanup(p_worker text,p_copy uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare v private.catalog_video_r2_staging_cleanup%rowtype;
begin
 if p_worker is null or length(p_worker) not between 8 and 200 then raise exception 'INVALID_INPUT'; end if;
 select * into v from private.catalog_video_r2_staging_cleanup where cleaned_at is null and next_attempt_at<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp()) and (p_copy is null or copy_id=p_copy) order by next_attempt_at limit 1 for update skip locked;
 if not found then return null; end if;
 update private.catalog_video_r2_staging_cleanup set fence=fence+1,lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1 where copy_id=v.copy_id returning * into v;
 return jsonb_build_object('copyId',v.copy_id,'objectKey',v.object_key,'etag',v.staging_etag,'fence',v.fence);
end $$;

create function public.service_catalog_video_r2_finish_staging_cleanup(p_copy uuid,p_fence bigint,p_success boolean,p_code text default null) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_code is not null and p_code !~ '^[A-Z][A-Z0-9_]{0,95}$' then raise exception 'INVALID_INPUT'; end if;
 update private.catalog_video_r2_staging_cleanup set cleaned_at=case when p_success then clock_timestamp() else null end,last_error=case when p_success then null else p_code end,lease_until=null,next_attempt_at=clock_timestamp()+interval '5 minutes' where copy_id=p_copy and fence=p_fence and lease_until>clock_timestamp() and cleaned_at is null;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
end $$;

revoke all on function private.catalog_video_r2_manifest(uuid) from public,anon,authenticated,service_role;
revoke all on function public.service_catalog_video_r2_verification_open(uuid,text,bigint,text,jsonb,text),public.service_catalog_video_r2_verification_advance(uuid,text,bigint,text,jsonb,integer,jsonb,text),public.service_catalog_video_r2_claim_staging_cleanup(text,uuid),public.service_catalog_video_r2_finish_staging_cleanup(uuid,bigint,boolean,text) from public,anon,authenticated;
grant execute on function public.service_catalog_video_r2_verification_open(uuid,text,bigint,text,jsonb,text),public.service_catalog_video_r2_verification_advance(uuid,text,bigint,text,jsonb,integer,jsonb,text),public.service_catalog_video_r2_claim_staging_cleanup(text,uuid),public.service_catalog_video_r2_finish_staging_cleanup(uuid,bigint,boolean,text) to service_role;

-- Content-free current observations. An old/as-of journal is never labelled as
-- a historical checkpoint; checksum, hash tail, manifest and object key stay private.
create view public.analytics_catalog_video_r2_verification with(security_invoker=false) as
select c.id copy_id,c.team_id,c.requested_by_catalog catalog_material_id,c.source_material_id,c.state,
 v.parts_checked,ceil(c.size_bytes::numeric/c.part_bytes)::integer total_parts,
 v.bytes_checked, v.final_md5 is not null full_source_proof,
 case when q.copy_id is null then 'not_queued' when q.cleaned_at is not null then 'complete' else 'pending' end staging_cleanup,
 q.attempts cleanup_attempts,
 case when q.last_error in ('VIDEO_R2_CHECKSUM_MISMATCH','VIDEO_R2_CLEANUP_PARTIAL','VIDEO_R2_PROVIDER_RATE_LIMITED','VIDEO_R2_PROVIDER_UNAVAILABLE','INVALID_RESPONSE') then q.last_error when q.last_error is not null then 'UNKNOWN' else null end cleanup_error,
 v.updated_at verified_at,q.cleaned_at
from private.catalog_video_r2_copies c left join private.catalog_video_r2_verification v on v.copy_id=c.id left join private.catalog_video_r2_staging_cleanup q on q.copy_id=c.id;
revoke all on public.analytics_catalog_video_r2_verification from public,anon,authenticated,service_role;
do $$ begin
 if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
  grant select on public.analytics_catalog_video_r2_verification to wishly_analytics_ro;
 end if;
end $$;
update private.catalog_video_r2_diagnostic_metadata set schema_version=2 where singleton;
