-- The per-minute re-verification of a registered catalog's initial publication
-- kept running for a catalog already in the trash (beta 2026-11-11, TR 10_e_v3:
-- eleven attempts five minutes apart, each ending PROCESS_RESULT_UNCERTAIN),
-- because initial_publication_reverify_owed never looked at the catalog
-- material. A catalog that is trashed or missing owes nothing: its publication
-- can neither be written nor verified.
--
-- The catalog material must now be active in the intent's team. The open-check
-- branch already requires the job to be blocked for adoption, so a superseded
-- or published job never counts. A claim for an intent whose catalog is no
-- longer active also closes its paced row as exhausted (CATALOG_INACTIVE), so
-- the stop is visible to diagnosis instead of a silent 'done'.
begin;
-- Whether the intent's catalog material is still active in its team. The
-- checkpoint id is cast only after it is proven to be a uuid.
create function private.initial_publication_catalog_active(i private.catalog_generation_intents) returns boolean language sql stable security definer set search_path='' as $$
 select case when i.checkpoint->>'materialId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then exists(select 1 from public.team_materials m where m.id=(i.checkpoint->>'materialId')::uuid and m.team_id=i.team_id and m.lifecycle='active')
  else false end
$$;
revoke all on function private.initial_publication_catalog_active(private.catalog_generation_intents) from public,anon,authenticated,service_role;

create or replace function private.initial_publication_reverify_owed(i private.catalog_generation_intents) returns boolean language sql stable security definer set search_path='' as $$
 select i.state='registered' and i.request_payload->>'catalogVideoProtocolVersion'='1'
 and jsonb_typeof(i.checkpoint->'initialVideoPlan')='object'
 and i.checkpoint->>'materialId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
 and private.initial_publication_catalog_active(i)
 and (
  exists(select 1 from private.catalog_initial_publication_checks ic join private.catalog_video_publication_jobs j on j.id=ic.job_id where ic.intent_id=i.id and ic.state='reading' and j.state='blocked' and j.blocked_reason='legacy_adoption_required')
  or (
   i.created_at>statement_timestamp()-interval '7 days'
   and not exists(select 1 from private.catalog_initial_publication_checks ic where ic.intent_id=i.id)
   and not exists(select 1 from private.catalog_video_publication_policies p where p.catalog_material_id=(i.checkpoint->>'materialId')::uuid)
  )
 )
$$;
revoke all on function private.initial_publication_reverify_owed(private.catalog_generation_intents) from public,anon,authenticated,service_role;

-- Claims one paced attempt (196000), and closes the row of a registered intent
-- whose catalog is no longer active, so its re-verification stops for good.
create or replace function public.service_claim_initial_publication_reverify(p_team uuid,p_actor uuid,p_intent uuid) returns text language plpgsql security definer set search_path='' as $$
declare i private.catalog_generation_intents%rowtype;r private.catalog_initial_publication_reverify%rowtype;
begin
 select * into i from private.catalog_generation_intents where id=p_intent and team_id=p_team and actor_id=p_actor for update;
 if i.id is null then return 'done';end if;
 if i.state='registered' and not private.initial_publication_catalog_active(i) then
  update private.catalog_initial_publication_reverify set exhausted_at=clock_timestamp(),last_code='CATALOG_INACTIVE',updated_at=clock_timestamp() where intent_id=p_intent and exhausted_at is null;
  return 'exhausted';
 end if;
 if not private.initial_publication_reverify_owed(i) then return 'done';end if;
 insert into private.catalog_initial_publication_reverify(intent_id,team_id,retry_after) values(p_intent,p_team,'-infinity') on conflict(intent_id) do nothing;
 select * into r from private.catalog_initial_publication_reverify where intent_id=p_intent for update;
 if r.exhausted_at is not null then return 'exhausted';end if;
 if r.retry_after>clock_timestamp() then return 'paced';end if;
 if r.attempts>=12 then
  update private.catalog_initial_publication_reverify set exhausted_at=clock_timestamp(),updated_at=clock_timestamp() where intent_id=p_intent;
  return 'exhausted';
 end if;
 update private.catalog_initial_publication_reverify set attempts=attempts+1,retry_after=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() where intent_id=p_intent;
 return 'go';
end;$$;
revoke all on function public.service_claim_initial_publication_reverify(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_claim_initial_publication_reverify(uuid,uuid,uuid) to service_role;

-- Rows already left open for a registered intent whose catalog is gone.
update private.catalog_initial_publication_reverify r set exhausted_at=clock_timestamp(),last_code='CATALOG_INACTIVE',updated_at=clock_timestamp()
 from private.catalog_generation_intents i
 where i.id=r.intent_id and r.exhausted_at is null and i.state='registered' and not private.initial_publication_catalog_active(i);
commit;
