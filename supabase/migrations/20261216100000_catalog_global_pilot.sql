-- Owner decision 2026-11-16: the shared white image pool (052) is tested on next in
-- chosen spaces before it is activated for everyone. next and production share this
-- database, so the pool cannot be switched on "for next" by its policy singleton:
-- activation (T0) is global and starts the 720-hour retirement of every space's own
-- images.
--
-- A pilot list makes the pool active for the listed spaces only. Inside a pilot space
-- catalogs, updates and launches draw from the shared pool exactly as after T0; every
-- other space, and the production 1.4.4 web, keep their own images. Nothing is
-- retired: the policy stays 'prepared', legacy settings stay writable, no deadline is
-- set. Activation for everyone remains the separate, explicit T0 step.
begin;

create table private.catalog_global_pilot_teams (
  team_id uuid primary key references public.teams(id) on delete cascade,
  added_at timestamptz not null default now(),
  note text check (note is null or char_length(note) <= 200)
);
revoke all on table private.catalog_global_pilot_teams from public, anon, authenticated;
-- Every catalog_* table keeps the attachment cleanup fence (20261205122000).
create trigger task_cleanup_reference_fence before insert or update on private.catalog_global_pilot_teams
  for each row execute function private.guard_task_cleanup_reference();

-- Active for a space: activated for everyone, or the space is in the pilot.
create function private.catalog_global_is_active(p_team uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.catalog_global_is_active()
      or (p_team is not null and exists (select 1 from private.catalog_global_pilot_teams where team_id = p_team));
$$;
revoke all on function private.catalog_global_is_active(uuid) from public, anon, authenticated, service_role;

do $pilot$
declare
  f record;
  d text;
  rewritten integer := 0;
begin
  -- Every producer that knows its space asks about that space.
  for f in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
       and p.prosrc like '%private.catalog_global_is_active()%'
       and p.proargnames @> array['p_team']
       and p.proname <> 'catalog_global_is_active'
  loop
    d := pg_get_functiondef(f.oid);
    d := replace(d, 'private.catalog_global_is_active()', 'private.catalog_global_is_active(p_team)');
    execute d;
    rewritten := rewritten + 1;
  end loop;
  if rewritten < 10 then raise exception 'CATALOG_GLOBAL_PILOT_PRODUCERS_MISSING %', rewritten; end if;

  -- Allocation and row validation required the global activation date.
  foreach d in array array[
    'public.service_catalog_global_allocate(uuid,uuid,uuid,uuid,integer,bigint,text,jsonb)',
    'public.service_catalog_global_validate_rows(uuid,jsonb)'
  ] loop
    select pg_get_functiondef(d::regprocedure) into d;
    if strpos(d, 'if cfg.activated_at is null ') = 0 then raise exception 'CATALOG_GLOBAL_PILOT_SEAM_MISSING'; end if;
    execute replace(d, 'if cfg.activated_at is null ', 'if not private.catalog_global_is_active(p_team) ');
  end loop;

  -- Readiness answers for the asking space.
  select pg_get_functiondef('public.service_catalog_global_readiness(uuid,uuid)'::regprocedure) into d;
  if strpos(d, 'usable:=cfg.activated_at is not null and') = 0
     or strpos(d, 'when cfg.activated_at is null then') = 0 then
    raise exception 'CATALOG_GLOBAL_PILOT_READINESS_SEAM_MISSING';
  end if;
  d := replace(d, 'usable:=cfg.activated_at is not null and', 'usable:=private.catalog_global_is_active(p_team) and');
  d := replace(d, 'when cfg.activated_at is null then', 'when not private.catalog_global_is_active(p_team) then');
  -- A pilot space sees the pool as active, so clients switch to it there and only there.
  if strpos(d, $s$'state',cfg.state,$s$) = 0 then raise exception 'CATALOG_GLOBAL_PILOT_READINESS_SEAM_MISSING'; end if;
  d := replace(d, $s$'state',cfg.state,$s$,
    $s$'state',case when cfg.activated_at is null and private.catalog_global_is_active(p_team) then 'active' else cfg.state end,$s$);
  execute d;
end $pilot$;

-- Platform administrators operate the pool: the owner reviews and refills it from the
-- admin page instead of a hand-granted operator row.
create or replace function private.catalog_global_operator(p_actor uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_actor is not null and (auth.uid() is null or auth.uid() = p_actor)
    and exists (select 1 from public.profiles p where p.id = p_actor and p.account_status = 'active')
    and (exists (select 1 from private.catalog_global_operators o where o.actor_id = p_actor)
         or exists (select 1 from public.admin_users a where a.user_id = p_actor));
$$;
revoke all on function private.catalog_global_operator(uuid) from public, anon, authenticated, service_role;

-- The admin page's one door to the pool: overview, gallery, hiding an image, the pilot
-- list, and serving configuration. Uploads go through catalog-global-images/control.
create function public.admin_catalog_global_pool(p_action text, p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  cfg private.catalog_global_policy%rowtype;
  target uuid;
  page_size integer;
  page_offset integer;
begin
  if not private.catalog_global_operator(actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) is distinct from 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into cfg from private.catalog_global_policy where singleton;

  if p_action = 'overview' then
    return jsonb_build_object(
      'policy', jsonb_build_object('state', cfg.state, 'environment', cfg.environment,
        'mediaOrigin', cfg.media_origin, 'routingRevision', cfg.routing_revision,
        'acceptedKeyVersions', to_jsonb(cfg.accepted_key_versions),
        'servingVerifiedAt', cfg.serving_verified_at, 'activatedAt', cfg.activated_at),
      'images', (select jsonb_build_object(
          'total', count(*),
          'ready', count(*) filter (where state = 'ready' and active),
          'pending', count(*) filter (where state in ('candidate', 'publishing', 'verifying')),
          'failed', count(*) filter (where state in ('failed', 'unknown')),
          'hidden', count(*) filter (where not active),
          'uses', coalesce(sum(confirmed_uses), 0))
        from private.catalog_global_images),
      'pilot', coalesce((select jsonb_agg(jsonb_build_object('teamId', t.id, 'name', t.name, 'addedAt', p.added_at) order by p.added_at)
        from private.catalog_global_pilot_teams p join public.teams t on t.id = p.team_id), '[]'::jsonb),
      'jobs', coalesce((select jsonb_agg(x order by x->>'createdAt' desc) from (
        select jsonb_build_object('id', j.id, 'state', j.state, 'totalFiles', j.total_files, 'createdAt', j.created_at,
          'ready', (select count(*) from private.catalog_global_entries e where e.job_id = j.id and e.state in ('ready', 'reused')),
          'failed', (select count(*) from private.catalog_global_entries e where e.job_id = j.id and e.state in ('failed', 'unknown', 'cancelled')),
          'waiting', (select count(*) from private.catalog_global_entries e where e.job_id = j.id and e.state = 'waiting_source')) x
          from private.catalog_global_jobs j where j.kind = 'import' order by j.created_at desc limit 5) recent), '[]'::jsonb));
  elsif p_action = 'images' then
    page_size := least(greatest(coalesce((p_payload->>'limit')::integer, 60), 1), 120);
    page_offset := greatest(coalesce((p_payload->>'offset')::integer, 0), 0);
    return jsonb_build_object('images', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('id', i.id, 'garment', i.garment, 'color', i.color, 'state', i.state,
        'active', i.active, 'uses', i.confirmed_uses, 'createdAt', i.created_at,
        'name', (select e.display_name from private.catalog_global_entries e where e.image_id = i.id order by e.id limit 1),
        'url', case when cfg.media_origin is not null then cfg.media_origin || '/' || i.canonical_key end) x
        from private.catalog_global_images i
       where (p_payload->>'garment' is null or i.garment = p_payload->>'garment')
         and (p_payload->>'color' is null or i.color = p_payload->>'color')
       order by i.garment nulls last, i.color nulls last, i.created_at, i.id
       limit page_size offset page_offset) page), '[]'::jsonb),
      'total', (select count(*) from private.catalog_global_images i
       where (p_payload->>'garment' is null or i.garment = p_payload->>'garment')
         and (p_payload->>'color' is null or i.color = p_payload->>'color')));
  elsif p_action in ('hide', 'show') then
    target := (p_payload->>'imageId')::uuid;
    update private.catalog_global_images set active = (p_action = 'show') where id = target;
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    return jsonb_build_object('imageId', target, 'active', p_action = 'show');
  elsif p_action = 'teams' then
    return jsonb_build_object('teams', coalesce((select jsonb_agg(jsonb_build_object('teamId', t.id, 'name', t.name)) from (
      select id, name from public.teams
       where p_payload->>'query' is null or name ilike '%' || replace(replace(p_payload->>'query', '%', ''), '_', '') || '%'
       order by name limit 20) t), '[]'::jsonb));
  elsif p_action = 'pilot_add' then
    target := (p_payload->>'teamId')::uuid;
    if not exists (select 1 from public.teams where id = target) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    insert into private.catalog_global_pilot_teams(team_id) values (target) on conflict do nothing;
    return public.admin_catalog_global_pool('overview', '{}');
  elsif p_action = 'pilot_remove' then
    delete from private.catalog_global_pilot_teams where team_id = (p_payload->>'teamId')::uuid;
    return public.admin_catalog_global_pool('overview', '{}');
  elsif p_action = 'configure' then
    perform public.service_catalog_global_control(actor, 'configure', p_payload);
    return public.admin_catalog_global_pool('overview', '{}');
  end if;
  raise exception 'INVALID_INPUT' using errcode = '22023';
end $$;
revoke all on function public.admin_catalog_global_pool(text, jsonb) from public, anon;
grant execute on function public.admin_catalog_global_pool(text, jsonb) to authenticated;

commit;
