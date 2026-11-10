-- A catalog registered while its first publication verification was still
-- open (the check stayed 'reading' after the create-time verification failed,
-- the recovery pass then registered the catalog) kept its autoupdate and
-- deferred video links blocked as legacy_adoption_required forever: nothing
-- listed it again. The recovery listing now also returns registered intents
-- with such an open check, paced to one attempt per five minutes by a
-- retry_after stamp that the verification's begin step advances.
begin;
alter table private.catalog_initial_publication_checks add column retry_after timestamptz not null default clock_timestamp();
do $pace$
declare d text;
begin
 select pg_get_functiondef('public.service_begin_initial_catalog_publication(uuid,uuid,uuid,uuid)'::regprocedure) into d;
 if strpos(d,$find$  if b.state='verified' then return jsonb_build_object('state','verified');end if;$find$)=0 then raise exception 'INITIAL_PUBLICATION_PACE_PATCH_MISSING';end if;
 d:=replace(d,$find$  if b.state='verified' then return jsonb_build_object('state','verified');end if;$find$,$replace$  if b.state='verified' then return jsonb_build_object('state','verified');end if;
  update private.catalog_initial_publication_checks set retry_after=statement_timestamp()+interval '5 minutes' where intent_id=b.intent_id;$replace$);
 execute d;
end $pace$;
do $listing$
declare d text;
begin
 select pg_get_functiondef('public.service_list_initial_catalog_recovery(integer)'::regprocedure) into d;
 if strpos(d,$find$ and i.state in('interrupted','create_started','created','finalized') and i.next_attempt_at<=statement_timestamp() and (i.lease_expires_at is null or i.lease_expires_at<=statement_timestamp())$find$)=0 then raise exception 'INITIAL_RECOVERY_LISTING_PATCH_MISSING';end if;
 d:=replace(d,$find$ and i.state in('interrupted','create_started','created','finalized') and i.next_attempt_at<=statement_timestamp() and (i.lease_expires_at is null or i.lease_expires_at<=statement_timestamp())$find$,$replace$ and ((i.state in('interrupted','create_started','created','finalized') and i.next_attempt_at<=statement_timestamp() and (i.lease_expires_at is null or i.lease_expires_at<=statement_timestamp())) or (i.state='registered' and exists(select 1 from private.catalog_initial_publication_checks ic join private.catalog_video_publication_jobs j on j.id=ic.job_id where ic.intent_id=i.id and ic.state='reading' and ic.retry_after<=statement_timestamp() and j.state='blocked' and j.blocked_reason='legacy_adoption_required')))$replace$);
 execute d;
end $listing$;
commit;
