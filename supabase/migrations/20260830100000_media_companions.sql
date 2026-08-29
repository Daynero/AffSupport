-- 012 (T001): a companion material — today a transcript — is linked 1:1 to the
-- video it shadows. `companion_of` names the owning video; `companion_kind`
-- says what the companion is; `audio_fingerprint` lets a second identical video
-- reuse the text without recomputing it, while still getting its own companion.

alter table public.team_materials
  add column if not exists companion_of uuid,
  add column if not exists companion_kind text,
  add column if not exists audio_fingerprint text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'team_materials_companion_of_fk'
  ) then
    alter table public.team_materials
      add constraint team_materials_companion_of_fk
      foreign key (companion_of) references public.team_materials(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'team_materials_companion_kind_check'
  ) then
    alter table public.team_materials
      add constraint team_materials_companion_kind_check
      check (
        (companion_of is null and companion_kind is null)
        or (companion_of is not null and companion_kind in ('transcript'))
      );
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'team_materials_audio_fingerprint_check'
  ) then
    alter table public.team_materials
      add constraint team_materials_audio_fingerprint_check
      check (audio_fingerprint is null or audio_fingerprint ~ '^[a-f0-9]{64}$');
  end if;
end $$;

-- One live transcript companion per video.
create unique index if not exists team_materials_one_companion_idx
  on public.team_materials (team_id, companion_of, companion_kind)
  where companion_of is not null and lifecycle = 'active';

create index if not exists team_materials_companion_of_idx
  on public.team_materials (team_id, companion_of)
  where companion_of is not null;

create index if not exists team_materials_audio_fingerprint_idx
  on public.team_materials (team_id, audio_fingerprint)
  where audio_fingerprint is not null;

-- 012 (T002): the transcript companion of a video, for the caller who may see it.
create or replace function public.get_material_transcript_companion(p_team uuid, p_material uuid)
returns table (
  id uuid,
  name text,
  ingest_state text,
  has_text boolean,
  drive_file_id text
)
language sql
security definer
set search_path = ''
as $$
  select companion.id,
         companion.name,
         companion.transcript_ingest_state,
         companion.transcript_text is not null and length(btrim(companion.transcript_text)) > 0,
         companion.drive_file_id
  from public.team_materials as companion
  where companion.team_id = p_team
    and companion.companion_of = p_material
    and companion.companion_kind = 'transcript'
    and companion.lifecycle = 'active'
    and private.can(p_team, 'view', auth.uid())
  order by companion.created_at desc
  limit 1;
$$;

revoke all on function public.get_material_transcript_companion(uuid, uuid) from public, anon;
grant execute on function public.get_material_transcript_companion(uuid, uuid) to authenticated;
