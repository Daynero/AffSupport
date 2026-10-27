-- 045: content-free durable evidence and SELECT-only diagnostic projections.
-- Forward-only; removal instructions belong to ROLLBACK.md. No provider I/O.
begin;
alter table private.catalog_image_journal
  add column actor_id uuid references auth.users(id) on delete set null,
  add column received_at timestamptz not null default clock_timestamp();

create function private.catalog_image_journal_actor() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.actor_id is null and new.job_id is not null then
    select j.actor_id into new.actor_id from public.team_catalog_image_imports j where j.id=new.job_id;
  end if;
  return new;
end $$;
create trigger catalog_image_journal_actor before insert on private.catalog_image_journal
for each row execute function private.catalog_image_journal_actor();

create function private.catalog_image_diagnostic_transition() returns trigger
language plpgsql security definer set search_path='' as $$
declare team uuid; job uuid; entry uuid; publication uuid; actor uuid; stage text; code text;
begin
  if tg_table_name='team_catalog_image_pool_entries' then
    if tg_op='UPDATE' and new.active is not distinct from old.active then return new; end if;
    insert into private.catalog_image_journal(team_id,publication_id,stage,occurred_at)
    values(new.team_id,new.publication_id,case when new.active then 'pool_added' else 'pool_removed' end,clock_timestamp());
    return new;
  end if;
  if tg_op='UPDATE' and new.state is not distinct from old.state then return new; end if;
  if tg_table_name='team_catalog_image_imports' then
    team:=new.team_id; job:=new.id; actor:=new.actor_id; stage:='import_'||new.state;
  elsif tg_table_name='catalog_image_import_entries' then
    team:=new.team_id; job:=new.job_id; entry:=new.id;
    publication:=coalesce(new.publication_id,new.candidate_publication_id);
    stage:=new.state; code:=new.error_code;
  elsif tg_table_name='catalog_image_publications' then
    team:=new.team_id; publication:=new.id; stage:='publication_'||new.state;
  elsif tg_table_name='catalog_image_uses' then
    team:=new.team_id; publication:=new.publication_id; stage:='use_'||new.state;
  elsif tg_table_name='catalog_image_purges' then
    publication:=new.publication_id; stage:='purge_'||new.state;
  end if;
  insert into private.catalog_image_journal(team_id,job_id,entry_id,publication_id,actor_id,stage,code,occurred_at)
  values(team,job,entry,publication,actor,stage,code,clock_timestamp());
  return new;
end $$;
create trigger catalog_image_import_diagnostics after insert or update of state on public.team_catalog_image_imports
for each row execute function private.catalog_image_diagnostic_transition();
create trigger catalog_image_entry_diagnostics after insert or update of state on private.catalog_image_import_entries
for each row execute function private.catalog_image_diagnostic_transition();
create trigger catalog_image_publication_diagnostics after insert or update of state on private.catalog_image_publications
for each row execute function private.catalog_image_diagnostic_transition();
create trigger catalog_image_use_diagnostics after insert or update of state on private.catalog_image_uses
for each row execute function private.catalog_image_diagnostic_transition();
create trigger catalog_image_purge_diagnostics after insert or update of state on private.catalog_image_purges
for each row execute function private.catalog_image_diagnostic_transition();
create trigger catalog_image_pool_diagnostics after insert or update of active on public.team_catalog_image_pool_entries
for each row execute function private.catalog_image_diagnostic_transition();
revoke all on function private.catalog_image_journal_actor(),private.catalog_image_diagnostic_transition()
from public,anon,authenticated,service_role;

create table private.catalog_image_diagnostic_metadata (
  singleton boolean primary key default true check(singleton),
  installed_at timestamptz not null default clock_timestamp(),
  schema_version integer not null default 1
);
insert into private.catalog_image_diagnostic_metadata(singleton) values(true);
revoke all on private.catalog_image_diagnostic_metadata from public,anon,authenticated,service_role;

create view public.analytics_catalog_image_journal with(security_invoker=false) as
select j.seq::text evidence_id,j.team_id,j.actor_id,j.job_id,j.entry_id,j.publication_id,
  case when j.stage in (
    'import_collecting','import_enumerating','import_sealed','import_running','import_completed',
    'import_partial','import_failed','import_cancelled','import_expired','import_awaiting_reconciliation',
    'waiting_source','staged','validating','deduplicating','publishing','verifying_origin',
    'verifying_public','committing','ready','reused','failed','cancelled','expired','awaiting_reconciliation',
    'publication_candidate','publication_put_unknown','publication_origin_verified','publication_public_verified',
    'publication_ready','publication_purging','publication_revoking','publication_revoked','publication_purge_unknown',
    'use_reserved','use_committed','use_superseded','use_unknown','pool_added','pool_removed',
    'purge_pending','purge_deleting','purge_cache_purging','purge_complete','purge_unknown'
  ) then j.stage else 'unknown' end stage,
  case when j.code is null then null when j.code in (
    'PERMISSION_DENIED','INVALID_INPUT','NOT_FOUND','CATALOG_IMAGE_UPGRADE_REQUIRED',
    'CATALOG_IMAGE_IMPORT_DISABLED','IMAGE_QUOTA_EXCEEDED','IMAGE_MANIFEST_INCOMPLETE',
    'IMAGE_SOURCE_UNAVAILABLE','IMAGE_SOURCE_CHANGED','IMAGE_LOCAL_SOURCE_REQUIRED',
    'IMAGE_UNSUPPORTED_FORMAT','IMAGE_TOO_LARGE','IMAGE_DIMENSIONS_INVALID',
    'IMAGE_ANIMATED_UNSUPPORTED','IMAGE_ORIENTATION_UNSUPPORTED','IMAGE_CONTENT_INVALID',
    'IMAGE_CLASSIFICATION_CONFLICT','IMAGE_TEXT_PAIRING_CONFLICT','IMAGE_PROVIDER_UNAVAILABLE',
    'IMAGE_PROVIDER_RATE_LIMITED','IMAGE_PUBLIC_VERIFICATION_FAILED','IMAGE_WRITE_UNCERTAIN',
    'IMAGE_DICTIONARY_COMMIT_FAILED','IMAGE_PUBLICATION_REVOKED','IDEMPOTENCY_CONFLICT','IMAGE_CLIPBOARD_UNAVAILABLE','IMAGE_UPLOAD_CAPACITY_BUSY'
  ) then j.code else 'UNKNOWN' end code,
  j.occurred_at,j.received_at
from private.catalog_image_journal j;

create view public.analytics_catalog_image_imports with(security_invoker=false) as
select j.id,j.team_id,j.actor_id,j.source_kind,j.state,j.revision,j.counts,j.created_at,j.source_deadline
from public.team_catalog_image_imports j;
create view public.analytics_catalog_image_publications with(security_invoker=false) as
select p.id,p.team_id,p.state,p.size_bytes,p.created_at,p.verified_at,
  case when p.classification->>'mode'='matched' then 'matched' else 'unclassified' end classification_mode,
  exists(select 1 from public.team_catalog_image_pool_entries e where e.team_id=p.team_id and e.publication_id=p.id and e.active) pool_active
from private.catalog_image_publications p;
create view public.analytics_catalog_image_uses with(security_invoker=false) as
select u.team_id,u.publication_id,u.catalog_attempt_id,u.row_identity,u.state,u.created_at
from private.catalog_image_uses u;
create view public.analytics_catalog_image_purges with(security_invoker=false) as
select p.id,p.publication_id,p.scope_id,p.reason,p.state,p.attempts,p.created_at,p.next_attempt_at
from private.catalog_image_purges p;
create view public.analytics_catalog_image_coverage with(security_invoker=false) as
select m.installed_at,m.schema_version,
  not exists(
    select 1 from (values
      ('public','team_catalog_image_imports','catalog_image_import_diagnostics'),
      ('private','catalog_image_import_entries','catalog_image_entry_diagnostics'),
      ('private','catalog_image_publications','catalog_image_publication_diagnostics'),
      ('private','catalog_image_uses','catalog_image_use_diagnostics'),
      ('private','catalog_image_purges','catalog_image_purge_diagnostics'),
      ('public','team_catalog_image_pool_entries','catalog_image_pool_diagnostics'),
      ('private','catalog_image_journal','catalog_image_journal_actor')
    ) expected(schema_name,table_name,trigger_name)
    where not exists(select 1 from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid=t.tgrelid
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname=expected.schema_name and c.relname=expected.table_name
        and t.tgname=expected.trigger_name and t.tgenabled in ('O','A') and not t.tgisinternal)
  ) capture_enabled
from private.catalog_image_diagnostic_metadata m where m.singleton;

-- Global content-free aggregates outlive detail without retaining user or team identities.
create table private.catalog_image_daily (
  day date not null,
  stage text not null check(length(stage)<=64),
  code text not null check(length(code)<=96),
  samples bigint not null check(samples>0),
  primary key(day,stage,code)
);
revoke all on private.catalog_image_daily from public,anon,authenticated,service_role;
create function private.catalog_image_daily_observe() returns trigger
language plpgsql security definer set search_path='' as $$
declare safe_stage text; safe_code text;
begin
  select j.stage,coalesce(j.code,'none') into safe_stage,safe_code
  from public.analytics_catalog_image_journal j where j.evidence_id=new.seq::text;
  insert into private.catalog_image_daily(day,stage,code,samples)
  values((new.received_at at time zone 'UTC')::date,safe_stage,safe_code,1)
  on conflict(day,stage,code) do update set samples=private.catalog_image_daily.samples+1;
  return new;
end $$;
create trigger catalog_image_daily_observe after insert on private.catalog_image_journal
for each row execute function private.catalog_image_daily_observe();
create view public.analytics_catalog_image_daily with(security_invoker=false) as
select day,stage,code,samples from private.catalog_image_daily;
create function private.prune_catalog_image_diagnostics() returns integer
language plpgsql security definer set search_path='' as $$
declare removed integer;
begin
  with expired as (select seq from private.catalog_image_journal where received_at<clock_timestamp()-interval '30 days' order by seq limit 1000)
  delete from private.catalog_image_journal j using expired e where j.seq=e.seq;
  get diagnostics removed=row_count;
  delete from private.catalog_image_daily where day<(clock_timestamp() at time zone 'UTC')::date-90;
  return removed;
end $$;
revoke all on function private.catalog_image_daily_observe(),private.prune_catalog_image_diagnostics()
from public,anon,authenticated,service_role;
do $$ begin
  if exists(select 1 from pg_catalog.pg_namespace where nspname='cron') then
    perform cron.schedule('catalog-image-diagnostics-retention','*/10 * * * *','select private.prune_catalog_image_diagnostics()');
  end if;
end $$;

revoke all on public.analytics_catalog_image_journal,public.analytics_catalog_image_imports,
public.analytics_catalog_image_publications,public.analytics_catalog_image_uses,
public.analytics_catalog_image_purges,public.analytics_catalog_image_coverage,public.analytics_catalog_image_daily
from public,anon,authenticated,service_role;
do $$ begin
  if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
    grant select on public.analytics_catalog_image_journal,public.analytics_catalog_image_imports,
    public.analytics_catalog_image_publications,public.analytics_catalog_image_uses,
    public.analytics_catalog_image_purges,public.analytics_catalog_image_coverage,public.analytics_catalog_image_daily to wishly_analytics_ro;
  end if;
end $$;
-- The platform conservatively inventories catalog metadata as potential material
-- references. Diagnostic tables obey the same late-reference fence as the core.
do $$ declare t record; begin
  for t in select * from private.task_cleanup_reference_tables()
    where table_name in ('catalog_image_diagnostic_metadata','catalog_image_daily') loop
    if not exists(select 1 from pg_catalog.pg_trigger g
      join pg_catalog.pg_class c on c.oid=g.tgrelid
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname=t.schema_name and c.relname=t.table_name
        and g.tgname='task_cleanup_reference_fence') then
      execute format('create trigger task_cleanup_reference_fence before insert or update on %I.%I for each row execute function private.guard_task_cleanup_reference()',t.schema_name,t.table_name);
    end if;
  end loop;
end $$;

-- Defense in depth: private metadata also obeys the platform RLS contract.
-- Only owner-run security-definer functions/views may cross this boundary.
alter table private.catalog_image_diagnostic_metadata enable row level security;
alter table private.catalog_image_daily enable row level security;
revoke all on private.catalog_image_diagnostic_metadata,private.catalog_image_daily from public,anon,authenticated,service_role;
commit;
