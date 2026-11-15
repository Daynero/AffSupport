-- The catalog name of a launch appeared only when its catalog step began: the
-- variant number in "<video>_v<n>_catalog" was allocated when the catalog
-- intent was begun, after every restitched video was ready (minutes, owner QA
-- 2026-11-15). People copy that name into Meta while the videos are made.
--
-- The number is now reserved when the generation is admitted. Allocation
-- counts reservations as taken, the launch's own catalog intent takes its
-- reserved number, and get_launch reports the name from the reservation until
-- the catalog's own name plan exists. A reservation of a canceled generation
-- frees its number again, like a canceled intent does (20261207263000).
-- Backward compatible: older clients ignore pendingCatalogName and the shared
-- allocation only skips more numbers.
begin;

create table private.launch_catalog_name_reservations (
  generation_id uuid primary key,
  team_id uuid not null,
  video_material_id uuid not null,
  variant integer not null check (variant > 0),
  created_at timestamptz not null default now(),
  foreign key (generation_id, team_id)
    references public.team_launch_generations(id, team_id) on delete cascade
);
create unique index launch_catalog_name_reserved_variant
  on private.launch_catalog_name_reservations(team_id, video_material_id, variant);
revoke all on table private.launch_catalog_name_reservations from public, anon, authenticated;
-- Every table naming a material keeps the attachment cleanup fence (20261205122000).
create trigger task_cleanup_reference_fence before insert or update on private.launch_catalog_name_reservations
  for each row execute function private.guard_task_cleanup_reference();

-- One allocation rule for every caller: catalogs, live intents and live reservations.
create function private.next_catalog_variant(p_team uuid, p_video uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce(max(v), 0) + 1 from (
    select coalesce(c.variant, 1) v from public.team_product_catalogs c
     where c.team_id = p_team and c.video_material_id = p_video
    union all
    select i.variant from private.catalog_generation_intents i
     where i.team_id = p_team and i.video_material_id = p_video
       and i.replaces_material_id is null and i.state <> 'canceled'
    union all
    select r.variant from private.launch_catalog_name_reservations r
      join public.team_launch_generations g on g.id = r.generation_id and g.team_id = r.team_id
     where r.team_id = p_team and r.video_material_id = p_video and g.state not like 'cancel%'
  ) numbers;
$$;
revoke all on function private.next_catalog_variant(uuid, uuid) from public, anon, authenticated;

-- The number a launch reserved for its catalog, while no live catalog or other intent holds it.
create function private.launch_reserved_catalog_variant(p_team uuid, p_video uuid, p_key text)
returns integer language sql stable security definer set search_path = '' as $$
  select r.variant from private.launch_catalog_name_reservations r
   where p_key ~ '^launch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:catalog$'
     and r.generation_id = split_part(p_key, ':', 2)::uuid
     and r.team_id = p_team and r.video_material_id = p_video
     and not exists (select 1 from public.team_product_catalogs c
                      where c.team_id = p_team and c.video_material_id = p_video
                        and coalesce(c.variant, 1) = r.variant)
     and not exists (select 1 from private.catalog_generation_intents i
                      where i.team_id = p_team and i.video_material_id = p_video
                        and i.replaces_material_id is null and i.state <> 'canceled'
                        and i.variant = r.variant);
$$;
revoke all on function private.launch_reserved_catalog_variant(uuid, uuid, text) from public, anon, authenticated;

-- Reserve at admission. A reservation only lets the name appear early: it never blocks admission.
create function private.reserve_launch_catalog_name() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cfg jsonb; video uuid;
begin
  select config into cfg from public.team_launch_revisions where id = new.revision_id and team_id = new.team_id;
  if cfg is null or cfg->>'method' is distinct from 'catalog'
     or coalesce(cfg->>'materialId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return new;
  end if;
  video := (cfg->>'materialId')::uuid;
  begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.team_id::text || 'catalog-variant' || video::text, 0));
    insert into private.launch_catalog_name_reservations(generation_id, team_id, video_material_id, variant)
    values (new.id, new.team_id, video, private.next_catalog_variant(new.team_id, video))
    on conflict do nothing;
  exception when others then
    null;
  end;
  return new;
end $$;
revoke all on function private.reserve_launch_catalog_name() from public, anon, authenticated;
create trigger reserve_launch_catalog_name after insert on public.team_launch_generations
  for each row execute function private.reserve_launch_catalog_name();

-- The intent allocation: the launch's reserved number first, the shared rule otherwise.
do $allocate$
declare d text;
begin
  select pg_get_functiondef('private.catalog_image_begin_intent_legacy(uuid,uuid,uuid,text,jsonb,uuid)'::regprocedure) into d;
  if strpos(d, $find$else select coalesce(max(variant),0)+1 into v from (select coalesce(variant,1) variant from public.team_product_catalogs where team_id=p_team and video_material_id=p_video union all select variant from private.catalog_generation_intents where team_id=p_team and video_material_id=p_video and replaces_material_id is null and state<>'canceled') variants;end if;$find$) = 0 then
    raise exception 'CATALOG_VARIANT_RESERVATION_PATCH_MISSING';
  end if;
  d := replace(d,
    $find$else select coalesce(max(variant),0)+1 into v from (select coalesce(variant,1) variant from public.team_product_catalogs where team_id=p_team and video_material_id=p_video union all select variant from private.catalog_generation_intents where team_id=p_team and video_material_id=p_video and replaces_material_id is null and state<>'canceled') variants;end if;$find$,
    $replace$else v:=coalesce(private.launch_reserved_catalog_variant(p_team,p_video,p_key),private.next_catalog_variant(p_team,p_video));end if;$replace$);
  execute d;
end $allocate$;

create or replace function public.service_next_product_catalog_variant(p_team uuid, p_video uuid)
returns integer language sql security definer set search_path = '' stable as $$
  select private.next_catalog_variant(p_team, p_video);
$$;

-- The name from the reservation until the catalog's own name plan exists.
create or replace function public.get_launch(p_team uuid, p_launch uuid, p_revision uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare detail_value jsonb; reserved text; generation uuid; v integer; video_name text;
begin
  detail_value := private.get_launch_before_bulk(p_team, p_launch, p_revision);
  if p_revision is null then
    generation := nullif(detail_value#>>'{generation,id}', '')::uuid;
    select i.checkpoint#>>'{namePlan,name}' into reserved from private.catalog_generation_intents i
     where i.team_id = p_team and i.request_key = 'launch:' || generation::text || ':catalog';
    if reserved is null and generation is not null then
      select coalesce(i.variant, r.variant), m.name into v, video_name
        from private.launch_catalog_name_reservations r
        join public.team_materials m on m.team_id = r.team_id and m.id = r.video_material_id
        left join private.catalog_generation_intents i
          on i.team_id = r.team_id and i.request_key = 'launch:' || r.generation_id::text || ':catalog'
         and i.state <> 'canceled'
       where r.generation_id = generation and r.team_id = p_team;
      if v is not null and video_name is not null then
        video_name := regexp_replace(btrim(normalize(video_name, NFC)), '\s+', ' ', 'g');
        reserved := coalesce(nullif(regexp_replace(video_name, '\.[^.]+$', ''), ''), video_name)
          || '_v' || v::text || '_catalog';
      end if;
    end if;
  end if;
  return detail_value || jsonb_build_object('pendingCatalogName', reserved);
end $$;
revoke all on function public.get_launch(uuid, uuid, uuid) from public, anon;
grant execute on function public.get_launch(uuid, uuid, uuid) to authenticated, service_role;

commit;
