-- Stable opaque image identity across ordinary clicks. This internal registry
-- does not admit a recipe, create a root, select or grant provider access.
begin;
create table private.restitch_candidate_versions (
 id uuid primary key default gen_random_uuid(),
 team_id uuid not null references public.teams(id) on delete cascade,
 connection_id uuid not null references public.team_drive_connections(id) on delete cascade,
 drive_file_id text not null check(length(drive_file_id) between 1 and 1024),
 checksum text not null check(checksum~'^[0-9a-f]{32}$'),
 mime_type text not null check(mime_type in('image/jpeg','image/png','image/webp')),
 size_bytes bigint not null check(size_bytes between 1 and 52428800),
 created_at timestamptz not null default clock_timestamp(),
 unique(team_id,connection_id,drive_file_id,checksum,mime_type,size_bytes)
);
alter table private.restitch_candidate_versions enable row level security;
alter table private.restitch_candidate_versions force row level security;
revoke all on private.restitch_candidate_versions from public,anon,authenticated,service_role;
create trigger task_cleanup_reference_fence before insert or update on private.restitch_candidate_versions
 for each row execute function private.guard_task_cleanup_reference();

create function private.register_restitch_candidate_version(p_team uuid,p_material uuid)
returns uuid language plpgsql security definer set search_path='' as $fn$
declare m public.team_materials%rowtype;d public.team_drive_connections%rowtype;v uuid;
begin
 select * into m from public.team_materials where id=p_material and team_id=p_team for share;
 if m.id is null or m.lifecycle<>'active' or m.kind<>'file' or m.category is distinct from 'image'
  or m.checksum is null or m.checksum!~'^[0-9a-f]{32}$'
  or m.size_bytes is null or m.size_bytes not between 1 and 52428800
  or m.mime_type is null or m.mime_type not in('image/jpeg','image/png','image/webp')
  or m.drive_file_id is null or length(m.drive_file_id) not between 1 and 1024 then
  raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
 select * into d from public.team_drive_connections where id=m.connection_id and team_id=p_team for share;
 if d.id is null or d.state<>'connected' then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 insert into private.restitch_candidate_versions(team_id,connection_id,drive_file_id,checksum,mime_type,size_bytes)
 values(p_team,m.connection_id,m.drive_file_id,m.checksum,m.mime_type,m.size_bytes)
 on conflict(team_id,connection_id,drive_file_id,checksum,mime_type,size_bytes) do nothing returning id into v;
 if v is null then
  select id into v from private.restitch_candidate_versions where team_id=p_team and connection_id=m.connection_id
   and drive_file_id=m.drive_file_id and checksum=m.checksum and mime_type=m.mime_type and size_bytes=m.size_bytes;
 end if;
 if v is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 return v;
end $fn$;
revoke all on function private.register_restitch_candidate_version(uuid,uuid) from public,anon,authenticated,service_role;
-- Registry rows never rewrite another version, including during repair/rename.
create function private.restitch_candidate_version_immutable() returns trigger
language plpgsql security definer set search_path='' as $fn$
begin raise exception 'WRONG_STATE' using errcode='55000';end $fn$;
revoke all on function private.restitch_candidate_version_immutable() from public,anon,authenticated,service_role;
create trigger restitch_candidate_version_immutable before update on private.restitch_candidate_versions
 for each row execute function private.restitch_candidate_version_immutable();
commit;
