-- Re-observing a grant created by this attempt must not turn it into a
-- pre-existing grant. Cancellation still owns its exact permission ID.
create or replace function public.service_record_catalog_permission(p_team uuid,p_intent uuid,p_actor uuid,p_owner uuid,p_fence text,p_file text,p_credential uuid,p_permission text,p_prior_anyone boolean,p_state text) returns void language plpgsql security definer set search_path='' as $$
declare r private.catalog_generation_intents%rowtype;
begin
 select * into r from private.catalog_generation_intents where id=p_intent and team_id=p_team for update;
 if p_actor is null or not private.can(p_team,'view',p_actor) or r.actor_id<>p_actor or r.lease_owner<>p_owner or r.fence::text<>p_fence or r.lease_expires_at<=clock_timestamp() then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if r.id is null or p_file is null or char_length(p_file) not between 1 and 200 or p_credential is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 insert into private.catalog_generation_sharing(intent_id,file_id,credential_id,permission_id,prior_anyone,created_by_attempt,state)
 values(p_intent,p_file,p_credential,p_permission,p_prior_anyone,p_permission is not null and not p_prior_anyone,p_state)
 on conflict(intent_id,file_id) do update set
  permission_id=coalesce(excluded.permission_id,catalog_generation_sharing.permission_id),
  created_by_attempt=catalog_generation_sharing.created_by_attempt or excluded.created_by_attempt,
  state=case
   when excluded.state='preserved' and not catalog_generation_sharing.prior_anyone
    and catalog_generation_sharing.state in('pending','cleanup_pending','created','preserved')
    then 'cleanup_pending'
   else excluded.state end,
  updated_at=clock_timestamp();
end $$;

-- Repair interrupted local/beta attempts whose created grant was re-observed.
update private.catalog_generation_sharing s set state='cleanup_pending',updated_at=clock_timestamp()
from private.catalog_generation_intents i,public.team_launch_generations g
where s.intent_id=i.id and i.request_key='launch:'||g.id::text||':catalog'
 and g.team_id=i.team_id and g.state in('cancel_requested','canceled_with_cleanup_pending')
 and s.state='preserved' and not s.prior_anyone and s.created_by_attempt;
