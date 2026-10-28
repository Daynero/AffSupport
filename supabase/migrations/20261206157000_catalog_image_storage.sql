-- Physical image quota belongs to the current workspace owner, across workspaces.
-- Removed library entries and uncertain writes remain charged until known purge.
-- Old tombstones carry no owner/size: refuse an upgrade that would invent credit.
do $$ begin
 if exists(select 1 from private.catalog_image_purges q left join private.catalog_image_publications p on p.id=q.publication_id
  where q.bucket_kind='public' and p.id is null and not(q.reason in ('explicit_revoke','team_deleted') and q.state='complete' and not q.uncertain_write)) then
  raise exception 'CATALOG_IMAGE_STORAGE_BACKFILL_UNATTRIBUTABLE: unresolved legacy public tombstone has no publication owner/size; resolve with trusted evidence before upgrade';
 end if;
end $$;

alter table private.catalog_image_import_entries
 add column source_size bigint check(source_size between 1 and 50000000),
 add column source_sha256 text check(source_sha256 ~ '^[0-9a-f]{64}$'),
 add column optimization_version text check(optimization_version in ('legacy-v0','lossless-v1')),
 add column canonical_size bigint check(canonical_size between 1 and 50000000),
 add column canonical_sha256 text check(canonical_sha256 ~ '^[0-9a-f]{64}$'),
 add column canonical_mime text check(canonical_mime in ('image/png','image/jpeg','image/webp'));

-- No FKs: attribution and bytes survive publication/team/account deletion.
create table private.catalog_image_storage (
 publication_id uuid primary key,
 object_key text not null unique,
 team_scope uuid not null,
 owner_scope uuid not null,
 size_bytes bigint not null check(size_bytes between 1 and 50000000),
 charged boolean not null default true,
 created_at timestamptz not null default now(),
 released_at timestamptz
);
create index catalog_image_storage_owner on private.catalog_image_storage(owner_scope) where charged;
create index catalog_image_storage_team on private.catalog_image_storage(team_scope);
alter table private.catalog_image_storage enable row level security;
alter table private.catalog_image_storage force row level security;
revoke all on private.catalog_image_storage from public,anon,authenticated,service_role;
-- The platform inventories all catalog_* tables, even without JSON columns.
create trigger task_cleanup_reference_fence before insert or update on private.catalog_image_storage
 for each row execute function private.guard_task_cleanup_reference();
insert into private.catalog_image_storage(publication_id,object_key,team_scope,owner_scope,size_bytes,charged,released_at)
 select p.id,p.object_key,p.team_id,t.owner_id,p.size_bytes,
  not coalesce(q.state='complete' and not q.uncertain_write and
   (q.reason in ('explicit_revoke','team_deleted') or (q.reason='orphan_candidate' and p.state='revoked')),false),
  case when q.state='complete' and not q.uncertain_write and
   (q.reason in ('explicit_revoke','team_deleted') or (q.reason='orphan_candidate' and p.state='revoked')) then clock_timestamp() end
 from private.catalog_image_publications p join public.teams t on t.id=p.team_id
 left join private.catalog_image_purges q on q.bucket_kind='public' and q.object_key=p.object_key;

-- One content-free revision per live team, consumed by the existing Realtime
-- channel. No FK: fanout must never take key locks on another owner's team row.
create table public.team_catalog_image_storage_signals (
 team_id uuid primary key,
 revision bigint not null default 1 check(revision>0),
 updated_at timestamptz not null default now()
);
alter table public.team_catalog_image_storage_signals enable row level security;
alter table public.team_catalog_image_storage_signals force row level security;
revoke all on public.team_catalog_image_storage_signals from public,anon,authenticated,service_role;
grant select(team_id,revision,updated_at) on public.team_catalog_image_storage_signals to authenticated;
create policy catalog_image_storage_signal_read on public.team_catalog_image_storage_signals for select to authenticated
 using(private.can(team_id,'view',auth.uid()));
create trigger task_cleanup_reference_fence before insert or update on public.team_catalog_image_storage_signals
 for each row execute function private.guard_task_cleanup_reference();
insert into public.team_catalog_image_storage_signals(team_id) select id from public.teams;
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(
  select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='team_catalog_image_storage_signals') then
  alter publication supabase_realtime add table public.team_catalog_image_storage_signals;
 end if;
end $$;

create function private.catalog_image_storage_bump(p_owner uuid,p_exclude_team uuid default null) returns void
language plpgsql security definer set search_path='' as $$
begin
 -- Caller already holds this account's advisory lock. Read team membership with
 -- MVCC only; signal rows have no FK and contain neither account IDs nor bytes.
 insert into public.team_catalog_image_storage_signals(team_id)
  select id from public.teams where owner_id=p_owner and (p_exclude_team is null or id<>p_exclude_team) order by id
 on conflict(team_id) do update set revision=team_catalog_image_storage_signals.revision+1,updated_at=clock_timestamp();
end $$;

create function private.catalog_image_storage_lock(p_team uuid,p_saved_owner uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare account uuid;
begin
 -- Team owner UPDATE/DELETE takes the row before invoking its trigger. Match that
 -- order. NO KEY UPDATE remains compatible with publication/pool FK KEY SHARE.
 select owner_id into account from public.teams where id=p_team for no key update;
 perform pg_advisory_xact_lock(hashtextextended('catalog-image-storage-team:'||p_team::text,0));
 -- A transfer+delete may have committed after a caller read its saved ledger
 -- owner. Once the team is gone, its durable attribution is the authority.
 if account is null then
  select owner_scope into account from private.catalog_image_storage where team_scope=p_team order by created_at,publication_id limit 1;
 end if;
 account:=coalesce(account,p_saved_owner);
 if account is null then raise exception 'NOT_FOUND'; end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-image-storage-account:'||account::text,0));
 return account;
end $$;

create function private.catalog_image_storage_charge() returns trigger
language plpgsql security definer set search_path='' as $$
declare account uuid; used bigint; images bigint;
begin
 account:=private.catalog_image_storage_lock(new.team_id);
 select coalesce(sum(size_bytes),0),count(*) into used,images from private.catalog_image_storage where owner_scope=account and charged;
 if used+new.size_bytes>1000000000 or images>=5000 then raise exception 'IMAGE_QUOTA_EXCEEDED'; end if;
 insert into private.catalog_image_storage(publication_id,object_key,team_scope,owner_scope,size_bytes)
 values(new.id,new.object_key,new.team_id,account,new.size_bytes);
 perform private.catalog_image_storage_bump(account);
 return new;
end $$;
create trigger catalog_image_storage_charge after insert on private.catalog_image_publications
 for each row execute function private.catalog_image_storage_charge();

create function private.catalog_image_storage_owner_changed() returns trigger
language plpgsql security definer set search_path='' as $$
declare first_owner uuid; second_owner uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('catalog-image-storage-team:'||old.id::text,0));
 if tg_op='DELETE' then
  perform pg_advisory_xact_lock(hashtextextended('catalog-image-storage-account:'||old.owner_id::text,0));
  delete from public.team_catalog_image_storage_signals where team_id=old.id;
  perform private.catalog_image_storage_bump(old.owner_id,old.id);
  return old;
 end if;
 if old.owner_id is not distinct from new.owner_id then return new; end if;
 first_owner:=least(old.owner_id,new.owner_id); second_owner:=greatest(old.owner_id,new.owner_id);
 perform pg_advisory_xact_lock(hashtextextended('catalog-image-storage-account:'||first_owner::text,0));
 perform pg_advisory_xact_lock(hashtextextended('catalog-image-storage-account:'||second_owner::text,0));
 -- Moving existing bytes is not growth and must not delete or refuse a transfer
 -- because the recipient is over quota. Subsequent growth is refused instead.
 update private.catalog_image_storage set owner_scope=new.owner_id where team_scope=old.id;
 -- BEFORE UPDATE sees the moving team under its old owner, so that fanout
 -- includes it; the new-owner fanout reaches all recipient's other teams.
 perform private.catalog_image_storage_bump(old.owner_id);
 perform private.catalog_image_storage_bump(new.owner_id);
 return new;
end $$;
create trigger catalog_image_00_storage_owner before update of owner_id or delete on public.teams
 for each row execute function private.catalog_image_storage_owner_changed();

-- Split source identity (Drive/staging bytes) from final immutable publication.
alter function public.service_catalog_image_reserve_v2(uuid,text,bigint,jsonb) set schema private;
alter function private.service_catalog_image_reserve_v2(uuid,text,bigint,jsonb) rename to catalog_image_reserve_pre_storage;
do $migration$
declare definition text; patch record;
begin
 definition:=pg_get_functiondef('private.catalog_image_reserve_pre_storage(uuid,text,bigint,jsonb)'::regprocedure);
 for patch in select * from (values
  ($old$or (p_image->>'size')::bigint<>e.declared_size$old$,$new$or (p_image->>'size')::bigint not between 1 and 50000000$new$),
  ($old$and size_bytes=e.declared_size$old$,$new$and size_bytes=(p_image->>'size')::bigint$new$),
  ($old$if total+e.declared_size>cfg.max_ready_bytes or n>=cfg.max_entries then raise exception 'IMAGE_QUOTA_EXCEEDED'; end if;$old$,$new$-- The cross-workspace owner ledger atomically admits the INSERT below.
  null;$new$),
  ($old$values(e.team_id,p_image->>'sha256',e.declared_size,p_image->>'mime'$old$,$new$values(e.team_id,p_image->>'sha256',(p_image->>'size')::bigint,p_image->>'mime'$new$)
 ) patches(old_source,new_source) loop
  if (length(definition)-length(replace(definition,patch.old_source,'')))<>length(patch.old_source) then raise exception '045 storage migration expected the known reserve source'; end if;
  definition:=replace(definition,patch.old_source,patch.new_source);
 end loop;
 execute definition;
end $migration$;
create function public.service_catalog_image_reserve_v2(p_entry uuid,p_worker text,p_fence bigint,p_image jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare entry private.catalog_image_import_entries%rowtype; team uuid; source_bytes bigint; source_hash text; version text;
begin
 select team_id into team from private.catalog_image_import_entries where id=p_entry;
 if team is null then raise exception 'NOT_FOUND'; end if;
 perform private.catalog_image_storage_lock(team);
 -- Match the foundation's job -> config -> entry order (including heartbeat).
 perform 1 from public.team_catalog_image_imports j join private.catalog_image_import_entries e on e.job_id=j.id where e.id=p_entry for update of j;
 perform 1 from private.catalog_image_config where team_id=team for update;
 select * into entry from private.catalog_image_import_entries where id=p_entry for update;
 if jsonb_typeof(p_image)<>'object' or jsonb_typeof(p_image->'size') is distinct from 'number'
  or (p_image->>'size')::numeric<>trunc((p_image->>'size')::numeric)
  or (p_image->>'size')::numeric not between 1 and 50000000
  or coalesce(p_image->>'sha256','') !~ '^[0-9a-f]{64}$'
  or coalesce(p_image->>'mime','') not in ('image/png','image/jpeg','image/webp') then raise exception 'IMAGE_CONTENT_INVALID'; end if;
 if p_image ?| array['sourceSize','sourceSha256','optimizationVersion'] then
  if jsonb_typeof(p_image->'sourceSize') is distinct from 'number'
   or (p_image->>'sourceSize')::numeric<>entry.declared_size
   or p_image->>'optimizationVersion' is distinct from 'lossless-v1'
   or (p_image ? 'sourceSha256' and coalesce(p_image->>'sourceSha256','') !~ '^[0-9a-f]{64}$') then raise exception 'IMAGE_CONTENT_INVALID'; end if;
  source_bytes:=(p_image->>'sourceSize')::bigint; source_hash:=p_image->>'sourceSha256'; version:='lossless-v1';
 else
  if (p_image->>'size')::bigint<>entry.declared_size then raise exception 'IMAGE_CONTENT_INVALID'; end if;
  source_bytes:=entry.declared_size; source_hash:=p_image->>'sha256'; version:='legacy-v0';
 end if;
 if (entry.source_size is not null and entry.source_size<>source_bytes)
  or (entry.source_sha256 is not null and entry.source_sha256 is distinct from source_hash)
  or (entry.optimization_version is not null and entry.optimization_version<>version)
  or (entry.canonical_size is not null and entry.canonical_size<>(p_image->>'size')::bigint)
  or (entry.canonical_sha256 is not null and entry.canonical_sha256<>p_image->>'sha256')
  or (entry.canonical_mime is not null and entry.canonical_mime<>p_image->>'mime') then raise exception 'IMAGE_SOURCE_CHANGED'; end if;
 update private.catalog_image_import_entries set source_size=source_bytes,source_sha256=coalesce(source_sha256,source_hash),optimization_version=version,
  canonical_size=(p_image->>'size')::bigint,canonical_sha256=p_image->>'sha256',canonical_mime=p_image->>'mime' where id=p_entry;
 return private.catalog_image_reserve_pre_storage(p_entry,p_worker,p_fence,p_image);
end $$;

-- Commit changes reserved/library/retained subsets even when no new byte is
-- charged. Take account locks before the foundation's job/config/publication
-- locks; a late pool trigger would introduce the inverse lock order.
alter function public.service_catalog_image_commit_v2(uuid,text,bigint,uuid,bigint,text) set schema private;
alter function private.service_catalog_image_commit_v2(uuid,text,bigint,uuid,bigint,text) rename to catalog_image_commit_pre_storage;
create function public.service_catalog_image_commit_v2(p_entry uuid,p_worker text,p_fence bigint,p_publication uuid,p_publication_fence bigint,p_url text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare team uuid; account uuid; was_active boolean; old_state text; result jsonb;
begin
 select team_id into team from private.catalog_image_import_entries where id=p_entry;
 if team is null then raise exception 'NOT_FOUND'; end if;
 account:=private.catalog_image_storage_lock(team);
 select active into was_active from public.team_catalog_image_pool_entries where team_id=team and publication_id=p_publication;
 select state into old_state from private.catalog_image_publications where id=p_publication and team_id=team;
 result:=private.catalog_image_commit_pre_storage(p_entry,p_worker,p_fence,p_publication,p_publication_fence,p_url);
 if was_active is distinct from true or old_state is distinct from 'ready' then perform private.catalog_image_storage_bump(account); end if;
 return result;
end $$;

-- Finish holds the same account as admission/owner transfer. Neither arbitrary
 -- publication state edits nor orphan "complete because retained" credit space.
alter function public.service_catalog_image_purge_finish_v2(uuid,bigint,boolean) set schema private;
alter function private.service_catalog_image_purge_finish_v2(uuid,bigint,boolean) rename to catalog_image_purge_finish_pre_storage;
create function public.service_catalog_image_purge_finish_v2(p_id uuid,p_fence bigint,p_success boolean)
returns void language plpgsql security definer set search_path='' as $$
declare ledger private.catalog_image_storage%rowtype; changed boolean; account uuid;
 old_purge_state text; next_purge_state text; old_uncertain boolean; next_uncertain boolean;
begin
 select s.* into ledger from private.catalog_image_storage s join private.catalog_image_purges q on q.publication_id=s.publication_id where q.id=p_id;
 if found then account:=private.catalog_image_storage_lock(ledger.team_scope,ledger.owner_scope); end if;
 select q.state,q.uncertain_write into old_purge_state,old_uncertain from private.catalog_image_purges q where q.id=p_id for update;
 perform private.catalog_image_purge_finish_pre_storage(p_id,p_fence,p_success);
 update private.catalog_image_storage s set charged=false,released_at=clock_timestamp()
 from private.catalog_image_purges q where q.id=p_id and q.publication_id=s.publication_id and s.charged
  and q.state='complete' and not q.uncertain_write and
   (q.reason in ('explicit_revoke','team_deleted') or (q.reason='orphan_candidate' and exists(
    select 1 from private.catalog_image_publications p where p.id=s.publication_id and p.state='revoked')));
 changed:=found;
 select q.state,q.uncertain_write into next_purge_state,next_uncertain from private.catalog_image_purges q where q.id=p_id;
 if account is not null and (changed or old_purge_state is distinct from next_purge_state or old_uncertain is distinct from next_uncertain) then
  perform private.catalog_image_storage_bump(account);
 end if;
end $$;

alter function public.service_catalog_image_control_v2(text,uuid,jsonb) set schema private;
alter function private.service_catalog_image_control_v2(text,uuid,jsonb) rename to catalog_image_control_pre_storage;
create function public.service_catalog_image_control_v2(p_action text,p_actor uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare team uuid; account uuid; used bigint; reserved bigint; pending bigint; library bigint; team_bytes bigint; images bigint; result jsonb; cursor_id uuid; revision bigint; old_revision bigint;
begin
 if jsonb_typeof(p_payload) is distinct from 'object' or p_actor is null then raise exception 'INVALID_INPUT'; end if;
 if p_payload->>'jobId' is not null then select team_id into team from public.team_catalog_image_imports where id=(p_payload->>'jobId')::uuid;
 elsif p_action='remove' then select team_id into team from public.team_catalog_image_pool_entries where id=(p_payload->>'entryId')::uuid;
 elsif p_action='revoke' then select team_id into team from private.catalog_image_publications where id=(p_payload->>'publicationId')::uuid;
 else team:=(p_payload->>'teamId')::uuid; end if;
 if team is not null then
  if not private.can(team,case when p_action in ('capabilities','get','list','dictionary','inventory','storage') then 'view' else 'manage_metadata' end,p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
  account:=private.catalog_image_storage_lock(team);
 end if;
 if p_action in ('storage','library') and team is null then raise exception 'NOT_FOUND'; end if;
 if p_action='storage' then
  select coalesce(sum(s.size_bytes),0),count(*),
   coalesce(sum(s.size_bytes) filter(where q.reason in ('explicit_revoke','team_deleted')),0),
   coalesce(sum(s.size_bytes) filter(where coalesce(q.reason,'') not in ('explicit_revoke','team_deleted') and p.state in ('candidate','put_unknown','origin_verified','public_verified')),0),
   coalesce(sum(s.size_bytes) filter(where p.state='ready' and e.active and coalesce(q.reason,'') not in ('explicit_revoke','team_deleted')),0),
   coalesce(sum(s.size_bytes) filter(where s.team_scope=team),0)
  into used,images,pending,reserved,library,team_bytes
  from private.catalog_image_storage s left join private.catalog_image_publications p on p.id=s.publication_id
  left join public.team_catalog_image_pool_entries e on e.publication_id=s.publication_id
  left join private.catalog_image_purges q on q.bucket_kind='public' and q.object_key=s.object_key
  where s.owner_scope=account and s.charged;
  return jsonb_build_object('limitBytes',1000000000,'limitImages',5000,'usedBytes',used,'reservedBytes',reserved,
   'pendingDeletionBytes',pending,'retainedBytes',used-pending-reserved-library,'libraryBytes',library,'totalImages',images,
   'availableBytes',greatest(0,1000000000-used),'teamBytes',team_bytes,'otherTeamBytes',used-team_bytes);
 elsif p_action='library' then
  cursor_id:=nullif(p_payload->>'cursor','')::uuid;
  select coalesce(c.revision,1) into revision from (select 1) stub left join private.catalog_image_config c on c.team_id=team;
  select coalesce(jsonb_agg(x.item order by x.id),'[]'::jsonb) into result from (
   select e.id,jsonb_build_object('id',e.id,'publicationId',p.id,'publicUrl',e.public_url,'classification',e.classification,
    'revision',e.revision,'sizeBytes',p.size_bytes,'active',e.active,'publicationState',case when exists(
     select 1 from private.catalog_image_purges deletion where deletion.publication_id=p.id
      and deletion.reason in ('explicit_revoke','team_deleted') and (deletion.state='unknown' or deletion.uncertain_write)
    ) then 'purge_unknown' else p.state end,
    'inUse',exists(select 1 from private.catalog_image_uses u where u.publication_id=p.id)
     or exists(select 1 from private.catalog_image_selections sel where sel.team_id=team and jsonb_path_exists(sel.images,'$[*] ? (@.publicationId == $id)',jsonb_build_object('id',p.id::text)))) item
   from public.team_catalog_image_pool_entries e join private.catalog_image_publications p on p.id=e.publication_id
   where e.team_id=team and p.state in ('ready','revoking','purge_unknown','purging') and (cursor_id is null or e.id>cursor_id)
   order by e.id limit 101
  ) x;
  return jsonb_build_object('items',case when jsonb_array_length(result)>100 then result-100 else result end,
   'total',(select count(*) from public.team_catalog_image_pool_entries e join private.catalog_image_publications p on p.id=e.publication_id where e.team_id=team and p.state in ('ready','revoking','purge_unknown','purging')),
   'revision',revision,'hasMore',jsonb_array_length(result)>100,'nextCursor',case when jsonb_array_length(result)>100 then result->99->>'id' else null end);
 end if;
 if p_action in ('remove','revoke') then select c.revision into old_revision from private.catalog_image_config c where c.team_id=team; end if;
 result:=private.catalog_image_control_pre_storage(p_action,p_actor,p_payload);
 if p_action in ('remove','revoke') and old_revision is distinct from (select c.revision from private.catalog_image_config c where c.team_id=team) then
  perform private.catalog_image_storage_bump(account);
 end if;
 return result;
end $$;

do $$ declare f record; begin
 for f in select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='private' and p.proname in ('catalog_image_storage_lock','catalog_image_storage_bump','catalog_image_storage_charge','catalog_image_storage_owner_changed','catalog_image_reserve_pre_storage','catalog_image_commit_pre_storage','catalog_image_purge_finish_pre_storage','catalog_image_control_pre_storage'))
   or (n.nspname='public' and p.proname in ('service_catalog_image_reserve_v2','service_catalog_image_commit_v2','service_catalog_image_purge_finish_v2','service_catalog_image_control_v2')) loop
  execute format('revoke all on function %I.%I(%s) from public,anon,authenticated,service_role',f.nspname,f.proname,f.args);
  if f.nspname='public' then execute format('grant execute on function %I.%I(%s) to service_role',f.nspname,f.proname,f.args); end if;
 end loop;
end $$;
