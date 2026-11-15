-- Owner QA 2026-11-15: a bulk launch stopped at 4 of 5 videos for good. The video
-- set binds every variant to the source's Drive version, and Drive moves that
-- version on metadata-only changes (sharing by link, properties). BG_8.mp4 went
-- from version 5 to 9 with the same md5 while the set was being made, so the fifth
-- variant's process start answered SOURCE_CHANGED on every attempt.
--
-- A metadata-only move now rebases the set: when the live version carries the
-- very bytes the set was made from (the md5 the set recorded), the set and the
-- process intents of its variants move to the live version together, so admission
-- and the catalog's own checks (which compare intents with the set) agree again.
-- Different bytes still refuse with SOURCE_CHANGED.
begin;

create function public.service_rebase_catalog_video_source(
  p_set uuid, p_hash bytea, p_native uuid, p_protocol integer, p_version text, p_checksum text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare s private.catalog_video_sets%rowtype; m public.team_materials%rowtype; previous text;
begin
  perform public.service_authorize_catalog_video_executor(p_set, p_hash, p_native, p_protocol);
  if p_version is null or char_length(p_version) not between 1 and 1024
     or p_checksum is null or p_checksum !~ '^[0-9a-f]{32}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into s from private.catalog_video_sets where id = p_set for update;
  if s.id is null or s.state not in ('accepted', 'preparing', 'unknown') then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  if s.source_version = p_version then return true; end if;
  select * into m from public.team_materials
   where id = s.source_material_id and team_id = s.team_id for update;
  -- Only the same bytes under a newer Drive version: anything else is a real change.
  if m.id is null or m.lifecycle <> 'active' or m.drive_version is distinct from p_version
     or m.checksum is distinct from p_checksum
     or s.source_snapshot->>'checksum' is distinct from p_checksum then
    raise exception 'SOURCE_CHANGED' using errcode = '55000';
  end if;
  previous := s.source_version;
  update private.team_operation_intents i set expected_source_version = p_version
   where i.team_id = s.team_id and i.tool_id = 'restitch' and i.expected_source_version = previous
     and i.operation_id in (select v.operation_id from private.catalog_video_variants v
                             where v.video_set_id = s.id and v.operation_id is not null);
  update private.catalog_video_sets
     set source_version = p_version,
         source_snapshot = jsonb_set(source_snapshot, '{version}', to_jsonb(p_version)),
         updated_at = clock_timestamp()
   where id = s.id;
  return true;
end $$;
revoke all on function public.service_rebase_catalog_video_source(uuid, bytea, uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.service_rebase_catalog_video_source(uuid, bytea, uuid, integer, text, text)
  to service_role;

commit;
