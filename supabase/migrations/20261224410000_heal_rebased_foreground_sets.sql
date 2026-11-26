-- Production 2026-11-26: set 3f284d98 (created 16:49 UTC) was rebased from Drive version 4 to 6
-- by the old service_rebase_catalog_video_source, an hour before 20261224400000 reached
-- production. The set moved; its window-bound authority and its picture context stayed at 4, so
-- every call of it — heartbeat, load, save — was refused with AUTH_REQUIRED, once every 30 s.
-- 20261224400000 fixed the rebase for what comes next and carried no heal: when it was checked,
-- no row was waiting. Anyone whose set was rebased before that release is in the same place.
--
-- This moves the two frozen copies to their own set's version, which is the one move the guards
-- of 20261224400000 allow and exactly what the rebase now does in its own transaction: the
-- rebase already proved the bytes (checksum against the material and the set's snapshot) when
-- it moved the set. Nothing else on either row changes.
--
-- Only sets the rebase itself acts on: accepted, preparing, unknown. A ready set was never
-- refused on the way (a stuck set cannot get there); a cancel_requested or canceled one is
-- finishing or finished, and its copies stay as they were.
--
-- Kept as a function so the heal can be proved (pgTAP) and, if ever needed, run again; it is
-- idempotent and nobody's to call but the owner.
begin;
create or replace function private.heal_rebased_foreground_sets()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare healed_authorities integer; healed_contexts integer; healed integer;
begin
  with lagging as (
    select s.id, s.source_version from private.catalog_video_sets s
     where s.state in ('accepted', 'preparing', 'unknown')
  ), authorities as (
    update private.catalog_video_foreground_authorities f
       set source_version = l.source_version, updated_at = clock_timestamp()
      from lagging l
     where f.video_set_id = l.id and f.source_version is distinct from l.source_version
    returning f.video_set_id
  )
  select count(*) into healed_authorities from authorities;
  with lagging as (
    select s.id, s.source_version from private.catalog_video_sets s
     where s.state in ('accepted', 'preparing', 'unknown')
  ), contexts as (
    update private.catalog_video_restitch_contexts c
       set source_version = l.source_version
      from lagging l
     where c.video_set_id = l.id and c.source_version is distinct from l.source_version
    returning c.video_set_id
  )
  select count(*) into healed_contexts from contexts;
  healed := healed_authorities + healed_contexts;
  raise notice 'heal_rebased_foreground_sets: % authority row(s), % context row(s)',
    healed_authorities, healed_contexts;
  return healed;
end $function$;
revoke all on function private.heal_rebased_foreground_sets() from public, anon, authenticated, service_role;

select private.heal_rebased_foreground_sets();
commit;
