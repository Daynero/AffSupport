-- A member inherits the owner's re-stitch settings until they explicitly choose their own.
-- The existing team row remains the owner's settings; personal rows never change it.
alter table public.team_restitch_defaults
  add column start_enabled boolean not null default true,
  add column end_enabled boolean not null default true,
  add column start_duration_mode text not null default 'one-frame'
    check (start_duration_mode in ('one-frame', 'ms-2', 'ms-5', 'ms-10', 'custom')),
  add column custom_start_duration_ms integer not null default 100
    check (custom_start_duration_ms between 1 and 60000);

create table public.team_member_restitch_preferences (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  use_owner boolean not null default true,
  operation text not null default 'restitch' check (operation in ('restitch', 'stitch', 'unstitch')),
  start_image_ids uuid[] not null default '{}',
  end_image_ids uuid[] not null default '{}',
  start_enabled boolean not null default true,
  end_enabled boolean not null default true,
  start_duration_mode text not null default 'one-frame'
    check (start_duration_mode in ('one-frame', 'ms-2', 'ms-5', 'ms-10', 'custom')),
  custom_start_duration_ms integer not null default 100
    check (custom_start_duration_ms between 1 and 60000),
  fit_mode text not null default 'cover' check (fit_mode in ('cover', 'contain', 'stretch')),
  final_duration_mode text not null default 'random-40-50'
    check (final_duration_mode in ('random-30-40', 'random-40-50', 'random-50-60', 'custom')),
  custom_final_duration_seconds integer not null default 2700
    check (custom_final_duration_seconds between 1 and 359999),
  configured boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

alter table public.team_member_restitch_preferences enable row level security;
alter table public.team_member_restitch_preferences force row level security;
revoke all on public.team_member_restitch_preferences from public, anon, authenticated;

create or replace function public.get_member_restitch_preference(p_team uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare
  owner_id uuid;
  defaults_source uuid;
  preference public.team_member_restitch_preferences;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  select team.owner_id into owner_id from public.teams as team where team.id = p_team;
  select updated_by into defaults_source from public.team_restitch_defaults where team_id = p_team;
  select * into preference from public.team_member_restitch_preferences
   where team_id = p_team and user_id = auth.uid();
  return jsonb_build_object(
    'ownerId', owner_id,
    'sourceUserId', case when auth.uid() = owner_id or coalesce(preference.use_owner, true)
      then coalesce(defaults_source, owner_id) else auth.uid() end,
    'useOwner', auth.uid() = owner_id or coalesce(preference.use_owner, true),
    'personalConfigured', coalesce(preference.configured, false)
  );
end;
$$;

create or replace function public.set_member_restitch_use_owner(p_team uuid, p_use_owner boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  if exists (select 1 from public.teams where id = p_team and owner_id = auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  insert into public.team_member_restitch_preferences (team_id, user_id, use_owner)
  values (p_team, auth.uid(), p_use_owner)
  on conflict (team_id, user_id) do update
    set use_owner = excluded.use_owner, updated_at = clock_timestamp();
  return public.get_member_restitch_preference(p_team);
end;
$$;

create or replace function public.set_member_restitch_defaults(p_team uuid, p_defaults jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation text := coalesce(p_defaults ->> 'operation', 'restitch');
  v_fit text := coalesce(p_defaults ->> 'fitMode', 'cover');
  v_mode text := coalesce(p_defaults ->> 'finalDurationMode', 'random-40-50');
  v_custom integer := coalesce((p_defaults ->> 'customFinalDurationSeconds')::integer, 2700);
  v_start_enabled boolean := coalesce((p_defaults ->> 'startEnabled')::boolean, true);
  v_end_enabled boolean := coalesce((p_defaults ->> 'endEnabled')::boolean, true);
  v_start_mode text := coalesce(p_defaults ->> 'startDurationMode', 'one-frame');
  v_start_ms integer := coalesce((p_defaults ->> 'customStartDurationMs')::integer, 100);
  v_start uuid[] := coalesce((select array_agg(value::uuid)
    from jsonb_array_elements_text(p_defaults -> 'startImageIds')), '{}');
  v_end uuid[] := coalesce((select array_agg(value::uuid)
    from jsonb_array_elements_text(p_defaults -> 'endImageIds')), '{}');
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) or
     exists (select 1 from public.teams where id = p_team and owner_id = auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  if v_operation not in ('restitch', 'stitch', 'unstitch')
     or v_fit not in ('cover', 'contain', 'stretch')
     or v_mode not in ('random-30-40', 'random-40-50', 'random-50-60', 'custom')
     or v_custom not between 1 and 359999
     or v_start_mode not in ('one-frame', 'ms-2', 'ms-5', 'ms-10', 'custom')
     or v_start_ms not between 1 and 60000
     then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  if v_operation <> 'unstitch' and
     (not v_start_enabled or cardinality(v_start) = 0) and
     (not v_end_enabled or cardinality(v_end) = 0) then
    raise exception 'RESTITCH_NO_SCREENS' using errcode = '22023';
  end if;
  insert into public.team_member_restitch_preferences as preference (
    team_id, user_id, use_owner, operation, start_image_ids, end_image_ids,
    start_enabled, end_enabled, start_duration_mode, custom_start_duration_ms, fit_mode,
    final_duration_mode, custom_final_duration_seconds, configured, updated_at
  ) values (
    p_team, auth.uid(), false, v_operation, v_start, v_end,
    v_start_enabled, v_end_enabled, v_start_mode, v_start_ms, v_fit,
    v_mode, v_custom, true, clock_timestamp()
  ) on conflict (team_id, user_id) do update set
    use_owner = false, operation = excluded.operation,
    start_image_ids = excluded.start_image_ids, end_image_ids = excluded.end_image_ids,
    start_enabled = excluded.start_enabled, end_enabled = excluded.end_enabled,
    start_duration_mode = excluded.start_duration_mode,
    custom_start_duration_ms = excluded.custom_start_duration_ms,
    fit_mode = excluded.fit_mode, final_duration_mode = excluded.final_duration_mode,
    custom_final_duration_seconds = excluded.custom_final_duration_seconds,
    configured = true, updated_at = clock_timestamp();
  return private.effective_restitch_defaults_json(p_team, auth.uid());
end;
$$;

create or replace function private.effective_restitch_defaults_json(p_team uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare
  owner_id uuid;
  preference public.team_member_restitch_preferences;
  defaults public.team_restitch_defaults;
begin
  select owner_id into owner_id from public.teams where id = p_team;
  select * into preference from public.team_member_restitch_preferences
    where team_id = p_team and user_id = p_actor;
  if p_actor <> owner_id and preference.user_id is not null and not preference.use_owner then
    if not preference.configured then return null; end if;
    return jsonb_build_object(
      'operation', preference.operation, 'startImageIds', to_jsonb(preference.start_image_ids),
      'endImageIds', to_jsonb(preference.end_image_ids), 'fitMode', preference.fit_mode,
      'startEnabled', preference.start_enabled, 'endEnabled', preference.end_enabled,
      'startDurationMode', preference.start_duration_mode,
      'customStartDurationMs', preference.custom_start_duration_ms,
      'finalDurationMode', preference.final_duration_mode,
      'customFinalDurationSeconds', preference.custom_final_duration_seconds,
      'configured', preference.configured, 'updatedAt', preference.updated_at,
      'updatedBy', preference.user_id
    );
  end if;
  select * into defaults from public.team_restitch_defaults where team_id = p_team;
  if defaults.team_id is null or not defaults.configured then return null; end if;
  return jsonb_build_object(
    'operation', defaults.operation, 'startImageIds', to_jsonb(defaults.start_image_ids),
    'endImageIds', to_jsonb(defaults.end_image_ids), 'fitMode', defaults.fit_mode,
    'startEnabled', defaults.start_enabled, 'endEnabled', defaults.end_enabled,
    'startDurationMode', defaults.start_duration_mode,
    'customStartDurationMs', defaults.custom_start_duration_ms,
    'finalDurationMode', defaults.final_duration_mode,
    'customFinalDurationSeconds', defaults.custom_final_duration_seconds,
    'configured', defaults.configured, 'updatedAt', defaults.updated_at,
    'updatedBy', defaults.updated_by
  );
end;
$$;

create or replace function public.get_effective_restitch_defaults(p_team uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  return private.effective_restitch_defaults_json(p_team, auth.uid());
end;
$$;

create or replace function public.service_get_effective_restitch_defaults(p_team uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
begin
  if p_actor is null or not private.can(p_team, 'process', p_actor) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  return private.effective_restitch_defaults_json(p_team, p_actor);
end;
$$;

revoke all on function private.effective_restitch_defaults_json(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_member_restitch_preference(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.set_member_restitch_use_owner(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.set_member_restitch_defaults(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.get_effective_restitch_defaults(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.service_get_effective_restitch_defaults(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_member_restitch_preference(uuid) to authenticated;
grant execute on function public.set_member_restitch_use_owner(uuid, boolean) to authenticated;
grant execute on function public.set_member_restitch_defaults(uuid, jsonb) to authenticated;
grant execute on function public.get_effective_restitch_defaults(uuid) to authenticated;
grant execute on function public.service_get_effective_restitch_defaults(uuid, uuid) to service_role;

-- Screen images are private team assets. A member can read them, while only their owner can
-- publish their own library snapshot. The browser transfers them to a paired local agent.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('team-restitch-images', 'team-restitch-images', false, 52428800,
  array['image/png', 'image/jpeg', 'image/webp']::text[])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy team_restitch_images_read on storage.objects for select to authenticated
using (bucket_id = 'team-restitch-images'
  and exists (select 1 from public.teams as team
    where team.id::text = (storage.foldername(name))[1]
      and private.can(team.id, 'view', auth.uid())));

create policy team_restitch_images_write on storage.objects for insert to authenticated
with check (bucket_id = 'team-restitch-images'
  and (storage.foldername(name))[2] = auth.uid()::text
  and exists (select 1 from public.teams as team
    where team.id::text = (storage.foldername(name))[1]
      and private.can(team.id, 'view', auth.uid())));

-- Only the owner may replace the defaults inherited by the entire space.
create or replace function public.set_restitch_defaults(p_team uuid, p_defaults jsonb)
returns public.team_restitch_defaults language plpgsql security definer set search_path = '' as $$
declare
  v_operation text := coalesce(p_defaults ->> 'operation', 'restitch');
  v_fit text := coalesce(p_defaults ->> 'fitMode', 'cover');
  v_mode text := coalesce(p_defaults ->> 'finalDurationMode', 'random-40-50');
  v_custom integer := coalesce((p_defaults ->> 'customFinalDurationSeconds')::integer, 2700);
  v_start_enabled boolean := coalesce((p_defaults ->> 'startEnabled')::boolean, true);
  v_end_enabled boolean := coalesce((p_defaults ->> 'endEnabled')::boolean, true);
  v_start_mode text := coalesce(p_defaults ->> 'startDurationMode', 'one-frame');
  v_start_ms integer := coalesce((p_defaults ->> 'customStartDurationMs')::integer, 100);
  v_start uuid[] := coalesce((select array_agg(value::uuid)
    from jsonb_array_elements_text(p_defaults -> 'startImageIds')), '{}');
  v_end uuid[] := coalesce((select array_agg(value::uuid)
    from jsonb_array_elements_text(p_defaults -> 'endImageIds')), '{}');
  saved public.team_restitch_defaults;
begin
  if auth.uid() is null or not exists (
    select 1 from public.teams where id = p_team and owner_id = auth.uid()
  ) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  if v_operation not in ('restitch', 'stitch', 'unstitch')
     or v_fit not in ('cover', 'contain', 'stretch')
     or v_mode not in ('random-30-40', 'random-40-50', 'random-50-60', 'custom')
     or v_custom not between 1 and 359999
     or v_start_mode not in ('one-frame', 'ms-2', 'ms-5', 'ms-10', 'custom')
     or v_start_ms not between 1 and 60000 then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  if v_operation <> 'unstitch' and
     (not v_start_enabled or cardinality(v_start) = 0) and
     (not v_end_enabled or cardinality(v_end) = 0) then
    raise exception 'RESTITCH_NO_SCREENS' using errcode = '22023';
  end if;
  insert into public.team_restitch_defaults as d (
    team_id, operation, start_image_ids, end_image_ids,
    start_enabled, end_enabled, start_duration_mode, custom_start_duration_ms, fit_mode,
    final_duration_mode, custom_final_duration_seconds, configured, updated_by, updated_at
  ) values (
    p_team, v_operation, v_start, v_end,
    v_start_enabled, v_end_enabled, v_start_mode, v_start_ms,
    v_fit, v_mode, v_custom, true, auth.uid(), clock_timestamp()
  ) on conflict (team_id) do update set
    operation = excluded.operation, start_image_ids = excluded.start_image_ids,
    end_image_ids = excluded.end_image_ids, fit_mode = excluded.fit_mode,
    start_enabled = excluded.start_enabled, end_enabled = excluded.end_enabled,
    start_duration_mode = excluded.start_duration_mode,
    custom_start_duration_ms = excluded.custom_start_duration_ms,
    final_duration_mode = excluded.final_duration_mode,
    custom_final_duration_seconds = excluded.custom_final_duration_seconds,
    configured = true, updated_by = excluded.updated_by, updated_at = clock_timestamp()
  returning * into saved;
  return saved;
end;
$$;
