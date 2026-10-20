-- Authoritative, content-free catalog settings observations. Baselines are not historical actions.
begin;
-- Prevent an unobserved write between the observation backfill and trigger installation.
lock table public.team_materials,public.team_product_catalogs,
  public.team_catalog_update_profiles,public.team_catalog_updater_items in share row exclusive mode;
create table private.catalog_settings_journal_metadata (
  singleton boolean primary key default true check(singleton),
  installed_at timestamptz not null default clock_timestamp(),
  schema_version integer not null default 1 check(schema_version = 1)
);
insert into private.catalog_settings_journal_metadata(singleton) values(true);
alter table private.catalog_settings_journal_metadata enable row level security;
alter table private.catalog_settings_journal_metadata force row level security;
revoke all on private.catalog_settings_journal_metadata from public,anon,authenticated,service_role;
create table private.catalog_settings_journal (
  event_id uuid primary key default gen_random_uuid(),
  observed_at timestamptz not null default clock_timestamp(),
  team_id uuid not null,
  catalog_material_id uuid not null,
  creator_id uuid,
  actor_id uuid,
  actor_kind text not null check (actor_kind in ('user','system_unknown')),
  source text not null check (source in ('baseline','change')),
  baseline_kind text check (baseline_kind in ('migration_observation','first_observation')),
  transaction_id bigint not null,
  profile_version bigint,
  before_state jsonb,
  after_state jsonb not null,
  changed_fields text[] not null default '{}',
  unique(transaction_id,catalog_material_id),
  check ((actor_id is null) = (actor_kind = 'system_unknown')),
  check ((source = 'baseline' and before_state is null and baseline_kind is not null and cardinality(changed_fields) = 0)
      or (source = 'change' and before_state is not null and baseline_kind is null and cardinality(changed_fields) > 0)),
  check (jsonb_typeof(after_state) = 'object' and after_state - array[
    'updateInterval','schedule','refreshImages','refreshTexts','growProducts',
    'randomLinkVariation','restitch','isActive','isDeleted'] = '{}'::jsonb)
);
create index catalog_settings_journal_catalog_time_idx on private.catalog_settings_journal(catalog_material_id,observed_at desc,event_id desc);
create index catalog_settings_journal_team_time_idx on private.catalog_settings_journal(team_id,observed_at desc);
create index catalog_settings_journal_actor_time_idx on private.catalog_settings_journal(actor_id,observed_at desc) where actor_id is not null;
-- A permanent lock row serializes observations from disjoint profile/item writers.
create table private.catalog_settings_journal_heads (
  catalog_material_id uuid primary key,
  revision bigint not null default 0
);
alter table private.catalog_settings_journal enable row level security;
alter table private.catalog_settings_journal force row level security;
alter table private.catalog_settings_journal_heads enable row level security;
alter table private.catalog_settings_journal_heads force row level security;
revoke all on private.catalog_settings_journal,private.catalog_settings_journal_heads from public,anon,authenticated,service_role;

create function private.catalog_settings_observation(p_catalog uuid)
returns table(team_id uuid,creator_id uuid,profile_version bigint,state jsonb)
language sql stable security definer set search_path = '' as $$
  select profile.team_id, catalog.created_by, profile.version,
    jsonb_build_object(
      'updateInterval',item.update_interval,'schedule',profile.schedule,
      'refreshImages',profile.refresh_images,'refreshTexts',profile.refresh_texts,
      'growProducts',profile.grow_products,'randomLinkVariation',profile.random_link_variation,
      'restitch',profile.restitch,'isDeleted',false,
      'isActive',coalesce(sheet.team_id = profile.team_id and sheet.lifecycle = 'active'
        and sheet.companion_kind = 'product_catalog' and video.lifecycle = 'active'
        and video.category = 'video',false))
  from public.team_catalog_update_profiles as profile
  join public.team_product_catalogs as catalog on catalog.material_id = profile.catalog_material_id
  left join public.team_catalog_updater_items as item on item.catalog_material_id = profile.catalog_material_id
  left join public.team_materials as sheet on sheet.id = profile.catalog_material_id
  left join public.team_materials as video on video.id = sheet.companion_of
  where profile.catalog_material_id = p_catalog;
$$;

create function private.record_catalog_settings_observation(p_catalog uuid,p_baseline_kind text default 'first_observation')
returns void language plpgsql security definer set search_path = '' as $$
declare current_row record; previous private.catalog_settings_journal; current_state jsonb;
  actor uuid := case when p_baseline_kind = 'migration_observation' then null else auth.uid() end; changed text[]; current_team uuid; current_creator uuid; version bigint;
begin
  if p_catalog is null then return; end if;
  insert into private.catalog_settings_journal_heads(catalog_material_id) values(p_catalog)
    on conflict(catalog_material_id) do nothing;
  -- Updating the lock row also refuses stale snapshots under repeatable-read isolation.
  update private.catalog_settings_journal_heads set revision = revision + 1 where catalog_material_id = p_catalog;
  select * into previous from private.catalog_settings_journal
    where catalog_material_id = p_catalog and transaction_id <> txid_current()
    order by observed_at desc,event_id desc limit 1;
  select * into current_row from private.catalog_settings_observation(p_catalog);
  if found then
    current_state := current_row.state;
    current_team := current_row.team_id;
    current_creator := current_row.creator_id;
    version := current_row.profile_version;
  elsif previous.event_id is not null then
    current_state := previous.after_state || jsonb_build_object('isActive',false,
      'isDeleted',not exists(select 1 from public.team_product_catalogs where material_id = p_catalog));
    current_team := previous.team_id; current_creator := previous.creator_id; version := previous.profile_version;
  else
    -- A catalog created and removed in one rolled-up transaction was never observed as committed.
    delete from private.catalog_settings_journal where catalog_material_id = p_catalog and transaction_id = txid_current();
    return;
  end if;
  if previous.event_id is not null and previous.after_state = current_state then
    delete from private.catalog_settings_journal where catalog_material_id = p_catalog and transaction_id = txid_current();
    return;
  end if;
  select coalesce(array_agg(key order by key),'{}'::text[]) into changed
    from jsonb_object_keys(current_state) as key
    where previous.event_id is not null and previous.after_state -> key is distinct from current_state -> key;
  insert into private.catalog_settings_journal(
    team_id,catalog_material_id,creator_id,actor_id,actor_kind,source,baseline_kind,
    transaction_id,profile_version,before_state,after_state,changed_fields)
  values(current_team,p_catalog,current_creator,actor,
    case when actor is null then 'system_unknown' else 'user' end,
    case when previous.event_id is null then 'baseline' else 'change' end,
    case when previous.event_id is null then p_baseline_kind else null end,
    txid_current(),version,previous.after_state,current_state,changed)
  on conflict(transaction_id,catalog_material_id) do update set
    observed_at = clock_timestamp(),team_id = excluded.team_id,creator_id = excluded.creator_id,
    actor_id = excluded.actor_id,actor_kind = excluded.actor_kind,source = excluded.source,
    baseline_kind = excluded.baseline_kind,profile_version = excluded.profile_version,
    before_state = excluded.before_state,after_state = excluded.after_state,changed_fields = excluded.changed_fields;
end;
$$;

create function private.track_catalog_settings_observation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare id uuid; material uuid;
begin
  if tg_table_name = 'team_materials' then
    material := case when tg_op = 'DELETE' then old.id else new.id end;
    -- The sheet itself and catalogs whose original/current companion is this video.
    for id in
      select candidate from (
        select material as candidate
        union select catalog.material_id from public.team_product_catalogs as catalog
          left join public.team_materials as sheet on sheet.id = catalog.material_id
          where catalog.video_material_id = material or sheet.companion_of = material
      ) as affected
      where exists(select 1 from public.team_catalog_update_profiles where catalog_material_id = candidate)
         or exists(select 1 from private.catalog_settings_journal where catalog_material_id = candidate)
      order by candidate
    loop perform private.record_catalog_settings_observation(id); end loop;
  elsif tg_table_name = 'team_product_catalogs' then
    perform private.record_catalog_settings_observation(case when tg_op = 'DELETE' then old.material_id else new.material_id end);
  else
    perform private.record_catalog_settings_observation(case when tg_op = 'DELETE' then old.catalog_material_id else new.catalog_material_id end);
  end if;
  return null;
end;
$$;
revoke all on function private.catalog_settings_observation(uuid),
  private.record_catalog_settings_observation(uuid,text),private.track_catalog_settings_observation()
  from public,anon,authenticated,service_role;

-- Observations start now. These rows never stand for a guessed past creation/action date.
do $$ declare catalog record; begin
  for catalog in select catalog_material_id from public.team_catalog_update_profiles order by team_id,catalog_material_id loop
    perform private.record_catalog_settings_observation(catalog.catalog_material_id,'migration_observation');
  end loop;
end $$;

create constraint trigger catalog_profile_settings_journal
  after insert or update or delete on public.team_catalog_update_profiles
  deferrable initially deferred for each row execute function private.track_catalog_settings_observation();
create constraint trigger catalog_interval_settings_journal
  after insert or update or delete on public.team_catalog_updater_items
  deferrable initially deferred for each row execute function private.track_catalog_settings_observation();
create constraint trigger catalog_record_settings_journal
  after insert or update or delete on public.team_product_catalogs
  deferrable initially deferred for each row execute function private.track_catalog_settings_observation();
create constraint trigger catalog_material_settings_journal
  after update on public.team_materials deferrable initially deferred for each row
  when (old.lifecycle is distinct from new.lifecycle or old.companion_of is distinct from new.companion_of
    or old.companion_kind is distinct from new.companion_kind or old.category is distinct from new.category
    or old.team_id is distinct from new.team_id)
  execute function private.track_catalog_settings_observation();
create constraint trigger catalog_material_deleted_journal
  after delete on public.team_materials deferrable initially deferred for each row
  execute function private.track_catalog_settings_observation();

create view public.analytics_catalog_settings_history with(security_invoker = off) as
select event_id,observed_at,team_id,catalog_material_id,creator_id,actor_id,actor_kind,
  source,baseline_kind,transaction_id,profile_version,before_state,after_state,changed_fields
from private.catalog_settings_journal;
create view public.analytics_catalog_settings_current with(security_invoker = off) as
select distinct on(journal.catalog_material_id)
  journal.observed_at,journal.team_id,journal.catalog_material_id,journal.creator_id,
  coalesce(profile.version,journal.profile_version) as profile_version,journal.after_state as state
from private.catalog_settings_journal as journal
left join public.team_catalog_update_profiles as profile on profile.catalog_material_id = journal.catalog_material_id
order by journal.catalog_material_id,journal.observed_at desc,journal.event_id desc;
create view public.analytics_catalog_settings_coverage with(security_invoker = off) as
select metadata.installed_at, metadata.schema_version,
  not exists (
    select 1 from (values
      ('team_catalog_update_profiles','catalog_profile_settings_journal'),
      ('team_catalog_updater_items','catalog_interval_settings_journal'),
      ('team_product_catalogs','catalog_record_settings_journal'),
      ('team_materials','catalog_material_settings_journal'),
      ('team_materials','catalog_material_deleted_journal')
    ) as expected(table_name,trigger_name)
    where not exists (
      select 1 from pg_catalog.pg_trigger as trigger
      join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
      join pg_catalog.pg_namespace as schema on schema.oid = relation.relnamespace
      where schema.nspname = 'public' and relation.relname = expected.table_name
        and trigger.tgname = expected.trigger_name and trigger.tgenabled in ('O','A')
        and trigger.tgdeferrable and trigger.tginitdeferred and not trigger.tgisinternal
    )
  ) as capture_enabled
from private.catalog_settings_journal_metadata as metadata where metadata.singleton;
revoke all on public.analytics_catalog_settings_history,public.analytics_catalog_settings_current,public.analytics_catalog_settings_coverage from public,anon,authenticated,service_role;
do $$ begin
  if exists(select 1 from pg_roles where rolname = 'wishly_analytics_ro') then
    grant select on public.analytics_catalog_settings_history,public.analytics_catalog_settings_current,public.analytics_catalog_settings_coverage to wishly_analytics_ro;
  end if;
end $$;
commit;
