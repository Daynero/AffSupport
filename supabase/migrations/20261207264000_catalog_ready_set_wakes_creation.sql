-- When the last video of a creation registered, its frozen catalog creation was
-- still waiting on the intent's backoff (next_attempt_at, set 30 s or more
-- ahead each time it was interrupted while videos were preparing), and was
-- picked up only by a later recovery pass: the catalog appeared 2-2.5 minutes
-- after the videos were ready (beta 2026-11-11, scenarios S3 and S10).
--
-- A set becoming ready now makes its creation due at once, so the next pass
-- (and the dialog's own resume) assembles the catalog without waiting out the
-- backoff. Only an unfinished intent with no live lease is touched.
begin;
create function private.catalog_ready_set_wakes_creation() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state='ready' and old.state is distinct from 'ready' and new.catalog_intent_id is not null then
  update private.catalog_generation_intents set next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
  where id=new.catalog_intent_id and team_id=new.team_id
   and state in('interrupted','create_started','created','finalized')
   and (lease_expires_at is null or lease_expires_at<=clock_timestamp())
   and next_attempt_at>clock_timestamp();
 end if;
 return null;
end $$;
revoke all on function private.catalog_ready_set_wakes_creation() from public,anon,authenticated,service_role;
create trigger catalog_ready_set_wakes_creation after update of state on private.catalog_video_sets
 for each row execute function private.catalog_ready_set_wakes_creation();
commit;
