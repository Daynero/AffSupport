-- Re-stitching works out of the box (owner, 2026-11-25).
--
-- A space with no saved re-stitch settings, or whose enabled start/end slot has no picture of its
-- own, uses Soty's standard pictures instead of refusing. The one case with no re-stitch is a
-- person who turned BOTH the start and the end off: the effective settings are then null, which
-- every caller already reads as "not configured" (RESTITCH_INVALID, 20261224160000).
--
-- Contract of private.effective_restitch_defaults_json (and so of get_effective_restitch_defaults,
-- service_get_effective_restitch_defaults, every frozen round/launch snapshot):
--   builtin: { version: 1, start: boolean, end: boolean }
--     start/end = the slot is ENABLED by the person and has no picture of their own (no saved row,
--     an empty Drive pool in 'drive' mode, an empty id list in 'legacy' mode), so Soty's standard
--     picture stands in. The pictures are static web assets, immutable per version:
--       v1 start  /restitch/soty-restitch-start.v1.png  sha256 10908c0a7e18c167e90febc3983025865580beeb7eb5d852c80ae072fe480989
--       v1 end    /restitch/soty-restitch-end.v1.png    sha256 03ddeba103fe5ab227c149b05b2ee40ed9e8177346f9c7bc91b7a5faf80485f6
--     (packages/shared RESTITCH_BUILTIN_SCREENS names the same files.)
--   configured: true whenever at least one slot is enabled (or the operation is 'unstitch').
--
-- Agents up to 1.6.x cannot fetch a picture from anywhere but the space's Drive, so the
-- execution fields are rewritten for them and an old agent never meets a slot it cannot fill:
--   builtin.start            -> startEnabled false (no start screen until an agent ships the picture)
--   builtin.end, own start   -> endEnabled false   (the person's start pictures are kept)
--   builtin.end, no own start-> automaticEndFrame true (the video's own last frame, the Launch
--                               fallback every agent since 1.2.7 renders)
--   no own picture at all    -> sourceMode 'drive' with empty id lists (no pool is drawn)
-- A future agent that bundles the v1 pictures reads `builtin` and renders them in place of those
-- compatibility fields. The person's own toggles are never read from here: the settings screen
-- reads get_restitch_defaults (the raw row).
create or replace function private.effective_restitch_defaults_json(p_team uuid, p_actor uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
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
begin
  select team.owner_id into settings_owner_id from public.teams as team where team.id = p_team;
  select * into preference from public.team_member_restitch_preferences
    where team_id = p_team and user_id = p_actor;
  if p_actor <> settings_owner_id and preference.user_id is not null and not preference.use_owner then
    pool_user := preference.user_id;
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
  -- What agents without the standard pictures can render (see the header).
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
$$;
revoke all on function private.effective_restitch_defaults_json(uuid, uuid) from public, anon, authenticated, service_role;
