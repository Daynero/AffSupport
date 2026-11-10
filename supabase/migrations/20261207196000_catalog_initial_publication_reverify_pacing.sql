-- 1.4.2 re-verified registered catalogs whose first publication verification
-- never finished, paced by a stamp that service_begin_initial_catalog_publication
-- advanced. Any exception inside begin rolled that stamp back, so an intent whose
-- begin raised (WRONG_STATE, PROCESS_RESULT_UNCERTAIN) was listed again on every
-- one-minute pass, forever, and three such intents held every recovery slot.
--
-- Two further gaps, both seen in production on 2026-11-10:
--  * a catalog whose first verification failed before its policy existed was
--    registered by the completed-result path with no publication policy at all,
--    so its deferred video link could never be written and nothing listed it;
--  * the no-restitch verification refreshes the original video through
--    service_capture_initial_catalog_publication_source, which refused every
--    registered intent, so it could never succeed after registration.
--
-- An attempt is now claimed in its own transaction before any work, five
-- minutes apart, at most twelve times; genuine recovery is listed first.
begin;

create table private.catalog_initial_publication_reverify (
 intent_id uuid primary key references private.catalog_generation_intents(id),
 team_id uuid not null,
 attempts integer not null default 0 check(attempts between 0 and 12),
 retry_after timestamptz not null default clock_timestamp(),
 last_code text check(last_code is null or last_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
 exhausted_at timestamptz,
 updated_at timestamptz not null default clock_timestamp()
);
alter table private.catalog_initial_publication_reverify enable row level security;
alter table private.catalog_initial_publication_reverify force row level security;
revoke all on private.catalog_initial_publication_reverify from public,anon,authenticated,service_role;

-- Whether a registered protocol-1 intent still owes its initial publication:
-- either its check is open with the job held for adoption, or no check and no
-- policy exist for its catalog at all.
create function private.initial_publication_reverify_owed(i private.catalog_generation_intents) returns boolean language sql stable security definer set search_path='' as $$
 select i.state='registered' and i.request_payload->>'catalogVideoProtocolVersion'='1'
 and jsonb_typeof(i.checkpoint->'initialVideoPlan')='object' and i.checkpoint->>'materialId' is not null
 and (
  exists(select 1 from private.catalog_initial_publication_checks ic join private.catalog_video_publication_jobs j on j.id=ic.job_id where ic.intent_id=i.id and ic.state='reading' and j.state='blocked' and j.blocked_reason='legacy_adoption_required')
  or (
   i.created_at>statement_timestamp()-interval '7 days'
   and not exists(select 1 from private.catalog_initial_publication_checks ic where ic.intent_id=i.id)
   and not exists(select 1 from private.catalog_video_publication_policies p where p.catalog_material_id::text=i.checkpoint->>'materialId')
  )
 )
$$;
revoke all on function private.initial_publication_reverify_owed(private.catalog_generation_intents) from public,anon,authenticated,service_role;

-- Claims one paced attempt. Commits on its own, so a later failure anywhere in
-- the verification can no longer roll the pacing back.
create function public.service_claim_initial_publication_reverify(p_team uuid,p_actor uuid,p_intent uuid) returns text language plpgsql security definer set search_path='' as $$
declare i private.catalog_generation_intents%rowtype;r private.catalog_initial_publication_reverify%rowtype;
begin
 select * into i from private.catalog_generation_intents where id=p_intent and team_id=p_team and actor_id=p_actor for update;
 if i.id is null or not private.initial_publication_reverify_owed(i) then return 'done';end if;
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

-- Records the closed code a paced attempt ended with, for diagnosis only.
create function public.service_note_initial_publication_reverify(p_team uuid,p_intent uuid,p_code text) returns void language sql security definer set search_path='' as $$
 update private.catalog_initial_publication_reverify set last_code=case when p_code ~ '^[A-Z][A-Z0-9_]{1,63}$' then p_code else 'UNKNOWN' end,updated_at=clock_timestamp()
 where intent_id=p_intent and team_id=p_team
$$;
revoke all on function public.service_note_initial_publication_reverify(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_note_initial_publication_reverify(uuid,uuid,text) to service_role;

-- Genuine recovery first; a registered intent is listed only while it is owed,
-- not paced and not exhausted.
create or replace function public.service_list_initial_catalog_recovery(p_limit integer default 3) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_limit is null or p_limit not between 1 and 3 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('teamId',x.team_id,'actorId',x.actor_id,'idempotencyKey',x.request_key) order by x.reverify,x.next_attempt_at,x.id) from (
 select i.team_id,i.actor_id,i.request_key,i.next_attempt_at,i.id,(i.state='registered') reverify from private.catalog_generation_intents i
 where i.request_payload->>'catalogVideoProtocolVersion'='1' and i.request_key ~ '^product-catalog:[0-9a-f-]{36}$'
 and ((i.state in('interrupted','create_started','created','finalized') and i.next_attempt_at<=statement_timestamp() and (i.lease_expires_at is null or i.lease_expires_at<=statement_timestamp()))
  or (private.initial_publication_reverify_owed(i) and not exists(select 1 from private.catalog_initial_publication_reverify r where r.intent_id=i.id and (r.exhausted_at is not null or r.retry_after>statement_timestamp()))))
 and private.can(i.team_id,'view',i.actor_id) and private.can(i.team_id,'upload',i.actor_id) and (i.request_payload->>'restitchEnabled'='false' or private.can(i.team_id,'process',i.actor_id))
 and (i.request_payload->>'restitchEnabled'='false' or i.request_payload#>>'{videoPublication,mode}'='scheduled' or exists(select 1 from private.catalog_video_sets s where s.catalog_intent_id=i.id and s.team_id=i.team_id and s.actor_id=i.actor_id and s.state='ready'))
 order by (i.state='registered'),i.next_attempt_at,i.id limit p_limit
 ) x),'[]'::jsonb);
end;$$;

-- A registered no-restitch catalog may refresh its original until its initial
-- publication check is verified; afterwards the refresh stays refused.
do $capture$
declare d text;
begin
 select pg_get_functiondef('public.service_capture_initial_catalog_publication_source(uuid,uuid,uuid,uuid,uuid,text,text,jsonb)'::regprocedure) into d;
 if strpos(d,$find$ and request_payload->>'restitchEnabled'='false' and state not in('canceled','registered') for update;$find$)=0 then raise exception 'INITIAL_PUBLICATION_CAPTURE_PATCH_MISSING';end if;
 d:=replace(d,$find$ and request_payload->>'restitchEnabled'='false' and state not in('canceled','registered') for update;$find$,$replace$ and request_payload->>'restitchEnabled'='false' and state<>'canceled' and (state<>'registered' or not exists(select 1 from private.catalog_initial_publication_checks verified where verified.intent_id=p_intent and verified.state='verified')) for update;$replace$);
 execute d;
end $capture$;

commit;
