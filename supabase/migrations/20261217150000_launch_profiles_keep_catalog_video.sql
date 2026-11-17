-- next QA 2026-11-17: «Зберегти налаштування → Для офера» (and «Як загальні») failed with
-- «Частина даних некоректна» on every catalog launch made since the catalog video protocol
-- (20261207171000). The editor's catalog carries catalogVideoProtocolVersion,
-- videoVariationCount and videoPublication, and the profile review already shows them, but the
-- saved-profile row check (validate_launch_defaults_row) still allowed only the catalog keys it
-- knew before, so the whole save was refused with nothing to point a field at.
--
-- The profile now keeps the three keys, checked as the client parses them
-- (parseLaunchCatalogVideoConfig, not strict: a profile is a preference, and a scheduled moment
-- or a variation count above the products is checked again when a launch is generated).
begin;

create or replace function private.launch_profile_catalog_video_valid(c jsonb)
returns boolean language sql immutable set search_path = '' as $$
  -- coalesce: a missing key reads as null, and a null here would let the row through.
  select coalesce(case
    when not (c ? 'catalogVideoProtocolVersion')
      then not (c ? 'videoVariationCount') and not (c ? 'videoPublication')
    else
      c->'catalogVideoProtocolVersion' = '1'::jsonb
      and jsonb_typeof(c->'videoVariationCount') = 'number'
      and c->>'videoVariationCount' ~ '^[0-9]+$'
      and (c->>'videoVariationCount')::numeric between 1 and 400
      and jsonb_typeof(c->'videoPublication') = 'object'
      and (
        c->'videoPublication' = '{"mode":"immediate"}'::jsonb
        or (
          c->'videoPublication'->>'mode' = 'scheduled'
          and c->'videoPublication' ?& array['localDateTime', 'timeZone', 'resolvedOffset', 'dueAt']
          and not exists (
            select 1 from jsonb_each(c->'videoPublication') e
             where e.key not in ('mode', 'localDateTime', 'timeZone', 'resolvedOffset', 'dueAt')
                or jsonb_typeof(e.value) <> 'string'
                or char_length(e.value #>> '{}') > 160)
        )
      )
  end, false)
$$;
revoke all on function private.launch_profile_catalog_video_valid(jsonb) from public, anon, authenticated;

do $do$
declare
  d text := pg_get_functiondef('private.validate_launch_defaults_row()'::regprocedure);
  seam constant text := 'allowed_key not in(''productCount'',''restitchEnabled'',''finalDurationMode'',''customFinalDurationSeconds'',''finalDurationRangeSeconds'',''copyVideoToR2''))';
begin
  if position(seam in d) = 0 then
    raise exception 'LAUNCH_DEFAULTS_CATALOG_SEAM_MISSING';
  end if;
  execute replace(
    d,
    seam,
    'allowed_key not in(''productCount'',''restitchEnabled'',''finalDurationMode'',''customFinalDurationSeconds'',''finalDurationRangeSeconds'',''copyVideoToR2'',''catalogVideoProtocolVersion'',''videoVariationCount'',''videoPublication'')) or not private.launch_profile_catalog_video_valid(c)'
  );
end
$do$;

commit;
