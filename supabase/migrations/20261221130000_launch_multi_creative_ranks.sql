-- 062: a Launch with several creatives credits every one of them.
--
-- The rank ledger held one event per (space, source kind, source): a Launch
-- credited only its materialId. A Launch now credits each creative of its
-- config (`creatives`, or `materialId` when there is no list), one event per
-- material. A catalog is still credited to its primary creative
-- (video_material_id = the first creative), so only that creative's Launch
-- event absorbs the catalog's credit; the other creatives are credited
-- without absorption. Configs without a list produce exactly one event as
-- before.
begin;

create function private.patch_function_062(p_function regprocedure, p_find text, p_replace text)
returns void language plpgsql set search_path = '' as $$
declare d text;
begin
  d := pg_catalog.pg_get_functiondef(p_function);
  if pg_catalog.strpos(d, p_find) = 0 then raise exception 'PATCH_062_ANCHOR_MISSING: %', p_function; end if;
  if pg_catalog.strpos(pg_catalog.substr(d, pg_catalog.strpos(d, p_find) + pg_catalog.length(p_find)), p_find) > 0 then
    raise exception 'PATCH_062_ANCHOR_AMBIGUOUS: %', p_function;
  end if;
  execute pg_catalog.replace(d, p_find, p_replace);
end $$;
revoke all on function private.patch_function_062(regprocedure, text, text) from public, anon, authenticated, service_role;

alter table public.team_creative_launch_events drop constraint team_creative_launch_events_source_unique;
alter table public.team_creative_launch_events add constraint team_creative_launch_events_source_unique
  unique (team_id, source_kind, source_id, material_id);

-- The creatives a Launch config credits, in order: its list, or its one material.
create function private.launch_config_material_ids(p_config jsonb)
returns setof uuid language sql immutable set search_path = '' as $$
  select distinct on (lower(m)) lower(m)::uuid from (
    select c.value->>'materialId' m, c.ordinality o
      from jsonb_array_elements(case when jsonb_typeof(p_config->'creatives') = 'array' and jsonb_array_length(p_config->'creatives') > 0
                                     then p_config->'creatives' else '[]'::jsonb end) with ordinality c
    union all
    select p_config->>'materialId', 0
     where not coalesce(jsonb_typeof(p_config->'creatives') = 'array' and jsonb_array_length(p_config->'creatives') > 0, false)
  ) x
  where m ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;
revoke all on function private.launch_config_material_ids(jsonb) from public, anon, authenticated, service_role;

-- One event per material of a source.
select private.patch_function_062('private.apply_creative_rank_event(uuid,uuid,text,uuid,timestamp with time zone,uuid,boolean)'::regprocedure,
  $find$     where e.team_id = p_team and e.source_kind = p_kind and e.source_id = p_source
  ) then$find$,
  $repl$     where e.team_id = p_team and e.source_kind = p_kind and e.source_id = p_source and e.material_id = p_material
  ) then$repl$);
select private.patch_function_062('private.apply_creative_rank_event(uuid,uuid,text,uuid,timestamp with time zone,uuid,boolean)'::regprocedure,
  $find$     where e.team_id = p_team and e.source_kind = 'catalog' and e.source_id = p_catalog
     for update;$find$,
  $repl$     where e.team_id = p_team and e.source_kind = 'catalog' and e.source_id = p_catalog and e.material_id = p_material
     for update;$repl$);
select private.patch_function_062('private.apply_creative_rank_event(uuid,uuid,text,uuid,timestamp with time zone,uuid,boolean)'::regprocedure,
  $find$  on conflict (team_id, source_kind, source_id) do nothing;$find$,
  $repl$  on conflict (team_id, source_kind, source_id, material_id) do nothing;$repl$);

-- A catalog is absorbed by the Launch event of the catalog's own (primary) creative.
create or replace function private.absorb_launch_catalog(p_team uuid, p_launch uuid, p_catalog uuid, p_backfilled boolean default false)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_launch public.team_creative_launch_events%rowtype;
  v_catalog public.team_creative_launch_events%rowtype;
begin
  if p_team is null or p_launch is null or p_catalog is null then
    return false;
  end if;
  select * into v_catalog from public.team_creative_launch_events e
   where e.team_id = p_team and e.source_kind = 'catalog' and e.source_id = p_catalog
   order by e.occurred_at, e.id limit 1
   for update;
  if v_catalog.id is null or v_catalog.absorbed_by_launch_id is not null then
    return false;
  end if;
  select * into v_launch from public.team_creative_launch_events e
   where e.team_id = p_team and e.source_kind = 'launch' and e.source_id = p_launch and e.material_id = v_catalog.material_id;
  if v_launch.id is null then
    return false;
  end if;
  update public.team_creative_launch_events
     set absorbed_by_launch_id = p_launch, counted = false
   where id = v_catalog.id;
  if v_catalog.counted and not p_backfilled then
    perform private.bump_creative_rank(p_team, v_catalog.material_id, -1, v_catalog.occurred_at);
  end if;
  return true;
end;
$$;

-- A successful Launch credits each of its creatives once.
create or replace function private.credit_launch_rank()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_config jsonb;
  v_catalog uuid;
  v_material uuid;
begin
  if new.state <> 'succeeded' or old.state = 'succeeded' then
    return null;
  end if;
  begin
    select r.config into v_config
      from public.team_launch_revisions r
     where r.id = new.revision_id and r.team_id = new.team_id;
    if v_config is null then
      return null;
    end if;
    select c.catalog_id into v_catalog
      from public.team_launch_revision_catalogs c
     where c.revision_id = new.revision_id and c.team_id = new.team_id;
    for v_material in select private.launch_config_material_ids(v_config) loop
      perform private.apply_creative_rank_event(
        new.team_id, v_material, 'launch', new.launch_id, new.updated_at, v_catalog
      );
    end loop;
    -- Sheets this Launch made before its first success (a failed attempt's) are this launch too.
    perform private.absorb_launch_catalog(new.team_id, new.launch_id, c.catalog_id)
       from public.team_launch_revision_catalogs c
       join public.team_launch_revisions r on r.id = c.revision_id and r.team_id = c.team_id
      where r.team_id = new.team_id and r.launch_id = new.launch_id;
  exception when unique_violation or foreign_key_violation or check_violation or deadlock_detected then
    -- A ledger race, a vanished row or a lock cycle must not undo a published Launch: the launch
    -- goes uncredited (visible in the CLI's ledger check) rather than unpublished.
    null;
  end;
  return null;
end;
$$;

-- The backfill credits every creative of a successful Launch too.
select private.patch_function_062('private.backfill_creative_ranks()'::regprocedure,
  $find$           g.team_id, g.launch_id, g.updated_at, r.config ->> 'materialId' as material_text,$find$,
  $repl$           g.team_id, g.launch_id, g.updated_at, r.config as config,$repl$);
select private.patch_function_062('private.backfill_creative_ranks()'::regprocedure,
  $find$    if l.material_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform private.apply_creative_rank_event(
        l.team_id, l.material_text::uuid, 'launch', l.launch_id, l.updated_at, l.catalog_id, true
      );
    end if;$find$,
  $repl$    perform private.apply_creative_rank_event(
        l.team_id, m, 'launch', l.launch_id, l.updated_at, l.catalog_id, true
      ) from private.launch_config_material_ids(l.config) m;$repl$);

drop function private.patch_function_062(regprocedure, text, text);

commit;
