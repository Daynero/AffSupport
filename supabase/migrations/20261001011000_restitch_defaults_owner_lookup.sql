-- Qualify the owner column: the old unqualified name collided with the local
-- variable and made every read of effective settings fail with SQLSTATE 42702.
create or replace function private.effective_restitch_defaults_json(p_team uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare
  settings_owner_id uuid;
  preference public.team_member_restitch_preferences;
  defaults public.team_restitch_defaults;
begin
  select team.owner_id into settings_owner_id from public.teams as team where team.id = p_team;
  select * into preference from public.team_member_restitch_preferences
    where team_id = p_team and user_id = p_actor;
  if p_actor <> settings_owner_id and preference.user_id is not null and not preference.use_owner then
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
