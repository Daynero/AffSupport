-- The initial-catalog recovery pass swallowed every exception (`catch {}`) for
-- an intent it had listed. A failure before the paced reverify claim -- an
-- accepted request the parser refuses, a source that no longer resolves, a
-- context RPC that raises -- left nothing behind, so the same intent was
-- listed again on every one-minute pass, forever, silently (beta 2026-11-11:
-- a held catalog listed every pass, never re-verified).
--
-- The pass now records such a failure here: a registered intent spends one
-- paced attempt (5 minutes, at most 12, then exhausted with the code); an
-- unfinished intent whose lease is free and that is already due is pushed five
-- minutes out. A live lease or a later attempt time is never touched.
begin;
create function public.service_defer_initial_catalog_recovery(p_team uuid,p_actor uuid,p_key text,p_code text) returns text language plpgsql security definer set search_path='' as $$
declare i private.catalog_generation_intents%rowtype;r private.catalog_initial_publication_reverify%rowtype;
 code text:=case when p_code ~ '^[A-Z][A-Z0-9_]{1,63}$' then p_code else 'UNKNOWN' end;
begin
 if p_team is null or p_actor is null or p_key is null or p_key !~ '^product-catalog:[0-9a-f-]{36}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and request_key=p_key for update;
 if i.id is null then return 'missing';end if;
 if i.state='registered' then
  insert into private.catalog_initial_publication_reverify(intent_id,team_id,retry_after) values(i.id,p_team,'-infinity') on conflict(intent_id) do nothing;
  select * into r from private.catalog_initial_publication_reverify where intent_id=i.id for update;
  if r.exhausted_at is not null then return 'exhausted';end if;
  if r.attempts>=11 then
   update private.catalog_initial_publication_reverify set attempts=12,exhausted_at=clock_timestamp(),last_code=code,updated_at=clock_timestamp() where intent_id=i.id;
   return 'exhausted';
  end if;
  update private.catalog_initial_publication_reverify set attempts=attempts+1,retry_after=clock_timestamp()+interval '5 minutes',last_code=code,updated_at=clock_timestamp() where intent_id=i.id;
  return 'deferred';
 end if;
 if i.state in('interrupted','create_started','created','finalized')
    and (i.lease_expires_at is null or i.lease_expires_at<=clock_timestamp())
    and i.next_attempt_at<=clock_timestamp() then
  update private.catalog_generation_intents set next_attempt_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() where id=i.id;
  return 'deferred';
 end if;
 return 'unchanged';
end $$;
revoke all on function public.service_defer_initial_catalog_recovery(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_defer_initial_catalog_recovery(uuid,uuid,text,text) to service_role;
commit;
