-- What 20261224450000 could not do by a rule alone: the rows that already exist (2026-11-26).
--
-- No pool needs a data change. A screen is chosen at read time, so a service file stopped being
-- chosen the moment private.restitch_screen_defect learned its name. Two things remain.
--
-- 1. Service files indexed as pictures, videos or transcripts before the rule. They become
--    `other`, as a new one now is from the start - except a file that a declared pool holds or
--    a re-stitch candidate list names. Two proofs hold such a file to being an image: a catalog
--    video set hands its frozen list to every later variant, and
--    private.restitch_selection_freeze_candidate refuses the whole variant (SOURCE_CHANGED) when
--    a frozen candidate is no longer an image; and private.launch_restitch_settings_version
--    hashes the declared pool into each accepted launch and refuses the launch when it moves.
--    Those files stay as they are. They are never drawn again, the settings panel lists them
--    under their pool, and they leave when their owner removes them from Drive.
--
-- 2. What agents have already said. Every rejection so far was written to the agent journal
--    (`team` / `screen_candidate_rejected`, reason `unsupported_image`, with the candidate
--    version). Those bytes are remembered now, so the files known to be useless are not drawn
--    once more just to learn it again. Only a record from a member of the version's space counts.
--
-- No file in anybody's Drive is touched. Idempotent: a second run changes nothing.
begin;
set local lock_timeout = '5s';

update public.team_materials as material
   set category = 'other', classification_source = 'fallback'
 where material.kind = 'file'
   and material.category is distinct from 'other'
   and private.os_service_file_name(material.name)
   and not exists (
     select 1 from private.catalog_video_restitch_candidates as candidate
      where candidate.material_id = material.id
   )
   and not exists (
     select 1 from private.restitch_selection_candidates as candidate
      where candidate.material_id = material.id
   )
   -- Nor a member of a pool as somebody declared it, used yet or not.
   and not exists (
     select 1
       from (
         select distinct source.team_id, source.user_id, source.slot
           from public.team_restitch_sources as source
          where source.team_id = material.team_id
       ) as pool
      cross join lateral private.restitch_pool_images(pool.team_id, pool.user_id, pool.slot)
        as member
      where member.material_id = material.id
   );

insert into private.restitch_screen_verdicts (
  team_id, checksum, mime_type, verdict, rejections, first_rejected_at, last_rejected_at
)
select version.team_id, version.checksum, version.mime_type, 'unusable',
       count(*)::integer, min(record.recorded_at), max(record.recorded_at)
  from public.agent_journal_records as record
  join private.restitch_candidate_versions as version
    on version.id = case
         when record.props ->> 'versionId'
              ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then (record.props ->> 'versionId')::uuid end
 where record.category = 'team'
   and record.code = 'screen_candidate_rejected'
   and record.props ->> 'reason' = 'unsupported_image'
   and exists (
     select 1 from public.team_members as member
      where member.team_id = version.team_id and member.user_id = record.user_id
   )
 group by version.team_id, version.checksum, version.mime_type
on conflict (team_id, checksum, mime_type) do nothing;

commit;
