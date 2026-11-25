-- 071: a space's final picture can be any random range of whole minutes from 1 to 60, or any
-- one exact length — the owner drags two handles on one slider instead of picking one of three
-- ten-minute windows.
--
-- Additive. A range is stored the way a launch already stores one: mode 'random-centered' with
-- `finalDurationRangeSeconds` [low, high] (whole minutes in seconds, 60–3600) and the middle as
-- `customFinalDurationSeconds`. Every reader that freezes a duration already understands it
-- (`private.freeze_restitch_selection_defaults`, drive-ops `sampleCatalogVideoDuration`); a
-- reader that knows only the centre (an agent's own draw up to 1.6.x) lands within five
-- minutes of it. The three old windows and 'custom' are written exactly as before, so a row
-- saved by an older screen reads unchanged.

alter table public.team_restitch_defaults
  add column if not exists final_duration_range_seconds integer[];
alter table public.team_member_restitch_preferences
  add column if not exists final_duration_range_seconds integer[];

alter table public.team_restitch_defaults
  drop constraint if exists team_restitch_defaults_duration_mode_check;
alter table public.team_restitch_defaults
  add constraint team_restitch_defaults_duration_mode_check
  check (final_duration_mode in ('random-30-40', 'random-40-50', 'random-50-60', 'random-centered', 'custom'));
alter table public.team_member_restitch_preferences
  drop constraint if exists team_member_restitch_preferences_final_duration_mode_check;
alter table public.team_member_restitch_preferences
  add constraint team_member_restitch_preferences_final_duration_mode_check
  check (final_duration_mode in ('random-30-40', 'random-40-50', 'random-50-60', 'random-centered', 'custom'));

alter table public.team_restitch_defaults
  add constraint team_restitch_defaults_duration_range_check
  check (final_duration_range_seconds is null or (
    cardinality(final_duration_range_seconds) = 2
    and final_duration_range_seconds[1] between 60 and 3600
    and final_duration_range_seconds[2] between final_duration_range_seconds[1] and 3600
    and final_duration_range_seconds[1] % 60 = 0 and final_duration_range_seconds[2] % 60 = 0));
alter table public.team_member_restitch_preferences
  add constraint team_member_restitch_preferences_duration_range_check
  check (final_duration_range_seconds is null or (
    cardinality(final_duration_range_seconds) = 2
    and final_duration_range_seconds[1] between 60 and 3600
    and final_duration_range_seconds[2] between final_duration_range_seconds[1] and 3600
    and final_duration_range_seconds[1] % 60 = 0 and final_duration_range_seconds[2] % 60 = 0));

-- The range a request carries, or null; refused unless it is exactly what the server can draw.
create or replace function private.restitch_duration_range_input(p_mode text, p_defaults jsonb)
returns integer[] language plpgsql immutable set search_path = '' as $$
declare
  range_value jsonb := p_defaults -> 'finalDurationRangeSeconds';
  low_value integer;
  high_value integer;
begin
  if p_mode is distinct from 'random-centered' or range_value is null or jsonb_typeof(range_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(range_value) <> 'array' or jsonb_array_length(range_value) <> 2
     or exists (select 1 from jsonb_array_elements(range_value) x
                where jsonb_typeof(x) <> 'number' or x::text !~ '^[0-9]+$') then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  low_value := (range_value ->> 0)::integer;
  high_value := (range_value ->> 1)::integer;
  if low_value not between 60 and 3600 or high_value not between low_value and 3600
     or low_value % 60 <> 0 or high_value % 60 <> 0 then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  return array[low_value, high_value];
end;
$$;
revoke all on function private.restitch_duration_range_input(text, jsonb) from public, anon, authenticated;

create or replace function public.set_restitch_defaults(p_team uuid, p_defaults jsonb)
returns public.team_restitch_defaults
language plpgsql security definer set search_path = '' as $function$
declare
  v_operation text := coalesce(p_defaults ->> 'operation', 'restitch');
  v_fit text := coalesce(p_defaults ->> 'fitMode', 'cover');
  v_mode text := coalesce(p_defaults ->> 'finalDurationMode', 'random-40-50');
  v_custom integer := coalesce((p_defaults ->> 'customFinalDurationSeconds')::integer, 2700);
  v_start_enabled boolean := coalesce((p_defaults ->> 'startEnabled')::boolean, true);
  v_end_enabled boolean := coalesce((p_defaults ->> 'endEnabled')::boolean, true);
  v_start_mode text := coalesce(p_defaults ->> 'startDurationMode', 'one-frame');
  v_start_ms integer := coalesce((p_defaults ->> 'customStartDurationMs')::integer, 100);
  v_source_mode text := coalesce(p_defaults ->> 'sourceMode', 'legacy');
  v_start uuid[] := coalesce((select array_agg(value::uuid)
    from jsonb_array_elements_text(p_defaults -> 'startImageIds')), '{}');
  v_end uuid[] := coalesce((select array_agg(value::uuid)
    from jsonb_array_elements_text(p_defaults -> 'endImageIds')), '{}');
  v_range integer[];
  saved public.team_restitch_defaults;
begin
  if auth.uid() is null or not exists (
    select 1 from public.teams where id = p_team and owner_id = auth.uid()
  ) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  if v_operation not in ('restitch', 'stitch', 'unstitch')
     or v_fit not in ('cover', 'contain', 'stretch')
     or v_mode not in ('random-30-40', 'random-40-50', 'random-50-60', 'random-centered', 'custom')
     or v_custom not between 1 and 359999
     or v_start_mode not in ('one-frame', 'ms-2', 'ms-5', 'ms-10', 'custom')
     or v_start_ms not between 1 and 60000
     or v_source_mode not in ('legacy', 'drive') then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  v_range := private.restitch_duration_range_input(v_mode, p_defaults);
  if v_source_mode = 'drive' then
    v_start := '{}'; v_end := '{}';
  elsif v_operation <> 'unstitch' and
     (not v_start_enabled or cardinality(v_start) = 0) and
     (not v_end_enabled or cardinality(v_end) = 0) then
    raise exception 'RESTITCH_NO_SCREENS' using errcode = '22023';
  end if;
  insert into public.team_restitch_defaults as d (
    team_id, operation, start_image_ids, end_image_ids,
    start_enabled, end_enabled, start_duration_mode, custom_start_duration_ms, fit_mode,
    final_duration_mode, custom_final_duration_seconds, final_duration_range_seconds,
    source_mode, configured, updated_by, updated_at
  ) values (
    p_team, v_operation, v_start, v_end,
    v_start_enabled, v_end_enabled, v_start_mode, v_start_ms,
    v_fit, v_mode, v_custom, v_range, v_source_mode, true, auth.uid(), clock_timestamp()
  ) on conflict (team_id) do update set
    operation = excluded.operation, start_image_ids = excluded.start_image_ids,
    end_image_ids = excluded.end_image_ids, fit_mode = excluded.fit_mode,
    start_enabled = excluded.start_enabled, end_enabled = excluded.end_enabled,
    start_duration_mode = excluded.start_duration_mode,
    custom_start_duration_ms = excluded.custom_start_duration_ms,
    final_duration_mode = excluded.final_duration_mode,
    custom_final_duration_seconds = excluded.custom_final_duration_seconds,
    final_duration_range_seconds = excluded.final_duration_range_seconds,
    source_mode = excluded.source_mode,
    configured = true, updated_by = excluded.updated_by, updated_at = clock_timestamp()
  returning * into saved;
  return saved;
end;
$function$;

create or replace function public.set_member_restitch_defaults(p_team uuid, p_defaults jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_operation text := coalesce(p_defaults ->> 'operation', 'restitch');
  v_fit text := coalesce(p_defaults ->> 'fitMode', 'cover');
  v_mode text := coalesce(p_defaults ->> 'finalDurationMode', 'random-40-50');
  v_custom integer := coalesce((p_defaults ->> 'customFinalDurationSeconds')::integer, 2700);
  v_start_enabled boolean := coalesce((p_defaults ->> 'startEnabled')::boolean, true);
  v_end_enabled boolean := coalesce((p_defaults ->> 'endEnabled')::boolean, true);
  v_start_mode text := coalesce(p_defaults ->> 'startDurationMode', 'one-frame');
  v_start_ms integer := coalesce((p_defaults ->> 'customStartDurationMs')::integer, 100);
  v_source_mode text := coalesce(p_defaults ->> 'sourceMode', 'legacy');
  v_start uuid[] := coalesce((select array_agg(value::uuid)
    from jsonb_array_elements_text(p_defaults -> 'startImageIds')), '{}');
  v_end uuid[] := coalesce((select array_agg(value::uuid)
    from jsonb_array_elements_text(p_defaults -> 'endImageIds')), '{}');
  v_range integer[];
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) or
     exists (select 1 from public.teams where id = p_team and owner_id = auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  if v_operation not in ('restitch', 'stitch', 'unstitch')
     or v_fit not in ('cover', 'contain', 'stretch')
     or v_mode not in ('random-30-40', 'random-40-50', 'random-50-60', 'random-centered', 'custom')
     or v_custom not between 1 and 359999
     or v_start_mode not in ('one-frame', 'ms-2', 'ms-5', 'ms-10', 'custom')
     or v_start_ms not between 1 and 60000
     or v_source_mode not in ('legacy', 'drive') then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  v_range := private.restitch_duration_range_input(v_mode, p_defaults);
  if v_source_mode = 'drive' then
    v_start := '{}'; v_end := '{}';
  elsif v_operation <> 'unstitch' and
     (not v_start_enabled or cardinality(v_start) = 0) and
     (not v_end_enabled or cardinality(v_end) = 0) then
    raise exception 'RESTITCH_NO_SCREENS' using errcode = '22023';
  end if;
  insert into public.team_member_restitch_preferences as preference (
    team_id, user_id, use_owner, operation, start_image_ids, end_image_ids,
    start_enabled, end_enabled, start_duration_mode, custom_start_duration_ms, fit_mode,
    final_duration_mode, custom_final_duration_seconds, final_duration_range_seconds,
    source_mode, configured, updated_at
  ) values (
    p_team, auth.uid(), false, v_operation, v_start, v_end,
    v_start_enabled, v_end_enabled, v_start_mode, v_start_ms, v_fit,
    v_mode, v_custom, v_range, v_source_mode, true, clock_timestamp()
  ) on conflict (team_id, user_id) do update set
    use_owner = false, operation = excluded.operation,
    start_image_ids = excluded.start_image_ids, end_image_ids = excluded.end_image_ids,
    start_enabled = excluded.start_enabled, end_enabled = excluded.end_enabled,
    start_duration_mode = excluded.start_duration_mode,
    custom_start_duration_ms = excluded.custom_start_duration_ms,
    fit_mode = excluded.fit_mode, final_duration_mode = excluded.final_duration_mode,
    custom_final_duration_seconds = excluded.custom_final_duration_seconds,
    final_duration_range_seconds = excluded.final_duration_range_seconds,
    source_mode = excluded.source_mode,
    configured = true, updated_at = clock_timestamp();
  return private.effective_restitch_defaults_json(p_team, auth.uid());
end;
$function$;

-- The effective settings of 20261224170000, unchanged but for one field: a stored range rides
-- along as `finalDurationRangeSeconds`, the key every freezer already reads.
create or replace function private.effective_restitch_defaults_json(p_team uuid, p_actor uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  settings_owner_id uuid;
  preference public.team_member_restitch_preferences;
  defaults public.team_restitch_defaults;
  base jsonb;
  pool_user uuid;
  start_on boolean;
  end_on boolean;
  own_start boolean;
  own_end boolean;
  builtin_start boolean;
  builtin_end boolean;
  range_value integer[];
begin
  select team.owner_id into settings_owner_id from public.teams as team where team.id = p_team;
  select * into preference from public.team_member_restitch_preferences
    where team_id = p_team and user_id = p_actor;
  if p_actor <> settings_owner_id and preference.user_id is not null and not preference.use_owner then
    pool_user := preference.user_id;
    range_value := preference.final_duration_range_seconds;
    base := jsonb_build_object(
      'operation', preference.operation, 'startImageIds', to_jsonb(preference.start_image_ids),
      'endImageIds', to_jsonb(preference.end_image_ids), 'fitMode', preference.fit_mode,
      'startEnabled', preference.start_enabled, 'endEnabled', preference.end_enabled,
      'startDurationMode', preference.start_duration_mode,
      'customStartDurationMs', preference.custom_start_duration_ms,
      'finalDurationMode', preference.final_duration_mode,
      'customFinalDurationSeconds', preference.custom_final_duration_seconds,
      'sourceMode', preference.source_mode,
      'configured', preference.configured, 'updatedAt', preference.updated_at,
      'updatedBy', preference.user_id
    );
  else
    select * into defaults from public.team_restitch_defaults where team_id = p_team;
    if defaults.team_id is not null then
      range_value := defaults.final_duration_range_seconds;
      base := jsonb_build_object(
        'operation', defaults.operation, 'startImageIds', to_jsonb(defaults.start_image_ids),
        'endImageIds', to_jsonb(defaults.end_image_ids), 'fitMode', defaults.fit_mode,
        'startEnabled', defaults.start_enabled, 'endEnabled', defaults.end_enabled,
        'startDurationMode', defaults.start_duration_mode,
        'customStartDurationMs', defaults.custom_start_duration_ms,
        'finalDurationMode', defaults.final_duration_mode,
        'customFinalDurationSeconds', defaults.custom_final_duration_seconds,
        'sourceMode', defaults.source_mode,
        'configured', defaults.configured, 'updatedAt', defaults.updated_at,
        'updatedBy', defaults.updated_by
      );
    end if;
  end if;
  if base is null then
    -- Never saved: the table's own column defaults, start and end on, Drive pools.
    base := jsonb_build_object(
      'operation', 'restitch', 'startImageIds', '[]'::jsonb, 'endImageIds', '[]'::jsonb,
      'fitMode', 'cover', 'startEnabled', true, 'endEnabled', true,
      'startDurationMode', 'one-frame', 'customStartDurationMs', 100,
      'finalDurationMode', 'random-40-50', 'customFinalDurationSeconds', 2700,
      'sourceMode', 'drive', 'configured', false, 'updatedAt', null, 'updatedBy', null
    );
  end if;
  if base->>'finalDurationMode' = 'random-centered' and range_value is not null then
    base := base || jsonb_build_object('finalDurationRangeSeconds', to_jsonb(range_value));
  end if;
  if base->>'operation' = 'unstitch' then
    return base || jsonb_build_object('configured', true,
      'builtin', jsonb_build_object('version', 1, 'start', false, 'end', false));
  end if;
  start_on := coalesce((base->>'startEnabled')::boolean, true);
  end_on := coalesce((base->>'endEnabled')::boolean, true);
  -- The one refusal left: the person turned both screens off.
  if not start_on and not end_on then return null; end if;
  if base->>'sourceMode' = 'drive' then
    own_start := start_on and exists(select 1 from private.restitch_pool_images(p_team, pool_user, 'start'));
    own_end := end_on and exists(select 1 from private.restitch_pool_images(p_team, pool_user, 'end'));
  else
    own_start := start_on and jsonb_array_length(coalesce(base->'startImageIds', '[]'::jsonb)) > 0;
    own_end := end_on and jsonb_array_length(coalesce(base->'endImageIds', '[]'::jsonb)) > 0;
  end if;
  builtin_start := start_on and not own_start;
  builtin_end := end_on and not own_end;
  base := base || jsonb_build_object('configured', true,
    'builtin', jsonb_build_object('version', 1, 'start', builtin_start, 'end', builtin_end));
  -- What agents without the standard pictures can render (see 20261224170000).
  if builtin_start then base := base || jsonb_build_object('startEnabled', false); end if;
  if builtin_end then
    if own_start then base := base || jsonb_build_object('endEnabled', false);
    else base := base || jsonb_build_object('automaticEndFrame', true); end if;
  end if;
  if not own_start and not own_end then
    base := base || jsonb_build_object('sourceMode', 'drive', 'startImageIds', '[]'::jsonb, 'endImageIds', '[]'::jsonb);
  end if;
  return base;
end;
$function$;
