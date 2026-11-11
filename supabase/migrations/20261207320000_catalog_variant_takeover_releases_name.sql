-- Beta 2026-11-11, set f91fc4c9 (agent killed mid-restitch, beta restarted):
-- the silence takeover of 20261207240000 failed the dead variant operation and
-- requeued the variant under a new request id, but the requeued admission was
-- refused NAME_CONFLICT and the set ended 'unknown' for good.
--
-- A variant's output name is fixed per set and index
-- (catalog_variant_<set>_<index>.mp4), and the name reservation unique index
-- holds while reservation_released_at is null. Every terminal transition made
-- through service_transition_team_operation releases it; the takeover, and the
-- 12-hour/15-minute abandonment of 20261207199000/240000, fail the operation
-- with a direct update that did not. A failed operation is immutable and the
-- start-time expiry sweep only releases active ones, so the retired operation
-- kept the name forever and every retry of that variant collided with it.
--
--  * any operation that reaches a terminal state releases its reservation and
--    revokes its transfer grants, however it got there;
--  * a terminal operation may still be stamped with that release (the only
--    change its immutability allows), and every terminal operation still
--    holding a reservation is released here;
--  * a variant the agent reported unknown because its admission was refused
--    before any operation existed is requeued under the same identity (no
--    execution fence was consumed; a late operation of the same request is the
--    same identity), and sets already stuck that way are requeued here.
--
-- The Drive side needs nothing: the takeover never retires an operation that
-- owns an upload or a provider result, and variant admission starts with
-- conflict mode keep_both, so a stray file of that name gets a suffixed sibling.
begin;

create function private.release_terminal_operation_reservation() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state in('succeeded','canceled','failed') and old.state not in('succeeded','canceled','failed') and new.reserved_name_key is not null then
  new.reservation_released_at:=coalesce(new.reservation_released_at,clock_timestamp());
 end if;
 return new;
end;$$;
revoke all on function private.release_terminal_operation_reservation() from public,anon,authenticated,service_role;
create trigger team_operations_release_terminal_reservation before update of state on public.team_operations
 for each row execute function private.release_terminal_operation_reservation();

create function private.revoke_terminal_operation_grants() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update private.team_transfer_grants set revoked_at=clock_timestamp() where operation_id=new.id and revoked_at is null;
 return null;
end;$$;
revoke all on function private.revoke_terminal_operation_grants() from public,anon,authenticated,service_role;
create trigger team_operations_revoke_terminal_grants after update of state on public.team_operations
 for each row when (new.state in('succeeded','canceled','failed') and old.state not in('succeeded','canceled','failed'))
 execute function private.revoke_terminal_operation_grants();

-- Terminal operations stay immutable except for the release of a name they
-- should already have released.
create or replace function private.team_validate_operation_transition() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.state in ('succeeded', 'canceled', 'failed') and new is distinct from old then
    if old.reservation_released_at is null and new.reservation_released_at is not null
       and to_jsonb(new) - 'reservation_released_at' - 'updated_at' = to_jsonb(old) - 'reservation_released_at' - 'updated_at' then
      return new;
    end if;
    raise exception 'TERMINAL_OPERATION_IMMUTABLE' using errcode = '23514';
  end if;
  if old.state = 'pending' and new.state not in ('pending', 'running', 'canceled', 'failed') then
    raise exception 'INVALID_OPERATION_TRANSITION' using errcode = '23514';
  end if;
  if old.state = 'running' and new.state not in ('running', 'succeeded', 'canceled', 'failed') then
    raise exception 'INVALID_OPERATION_TRANSITION' using errcode = '23514';
  end if;
  return new;
end;
$$;

update public.team_operations set reservation_released_at=coalesce(finished_at,clock_timestamp())
 where state in('succeeded','canceled','failed') and reserved_name_key is not null and reservation_released_at is null;

-- A variant reported unknown before any operation of its request existed was
-- never admitted: requeue it under the same identity.
do $requeue$
declare d text;needle text:=$find$ if o.id is null or (v.operation_id is not null and v.operation_id is distinct from o.id) then return jsonb_build_object('kind','unknown');end if;$find$;
begin
 select pg_get_functiondef('private.retry_failed_catalog_video_variant(uuid,integer)'::regprocedure) into d;
 if strpos(d,needle)=0 then raise exception 'VARIANT_REQUEUE_SEAM_CHANGED';end if;
 d:=replace(d,needle,$add$ if o.id is null and v.operation_id is null and v.state='unknown'
  and not exists(select 1 from private.team_recovery_execution_fences f where f.team_id=s.team_id and f.job_id=v.request_id) then
  delete from private.catalog_video_grant_rounds where video_set_id=p_set and video_variant_index=p_index;
  update private.catalog_video_variants set state='queued',dispatch_credential_hash=null,dispatch_native_instance_id=null,grant_refreshes=0,silence_observed_at=null where video_set_id=p_set and video_variant_index=p_index;
  update private.catalog_video_sets set revision=revision+1,state=case when exists(select 1 from private.catalog_video_variants where video_set_id=p_set and state='unknown') then 'unknown' else 'preparing' end,updated_at=clock_timestamp() where id=p_set;
  return jsonb_build_object('kind','requeued','requestId',v.request_id,'attempt',v.retry_count);
 end if;
$add$||needle);
 execute d;
end $requeue$;

-- The owner-scoped retry counts a requeue as a retry.
do $owner$
declare d text;needle text:=$find$if answer->>'kind'='retry' then retried:=retried+1;$find$;
begin
 select pg_get_functiondef('public.service_retry_failed_catalog_video_variants(uuid,uuid,uuid)'::regprocedure) into d;
 if strpos(d,needle)=0 then raise exception 'VARIANT_REQUEUE_OWNER_SEAM_CHANGED';end if;
 d:=replace(d,needle,$replace$if answer->>'kind' in('retry','requeued') then retried:=retried+1;$replace$);
 execute d;
end $owner$;

-- Sets already stuck this way.
do $repair$
declare stuck record;
begin
 for stuck in select v.video_set_id,v.video_variant_index from private.catalog_video_variants v join private.catalog_video_sets s on s.id=v.video_set_id
  where v.state='unknown' and v.operation_id is null and s.state in('accepted','preparing','unknown')
  and not exists(select 1 from public.team_operations o where o.team_id=s.team_id and o.actor_id=s.actor_id and o.kind='process' and o.idempotency_key='catalog-variant:'||v.request_id::text)
  order by v.video_set_id,v.video_variant_index loop
  perform private.retry_failed_catalog_video_variant(stuck.video_set_id,stuck.video_variant_index);
 end loop;
end $repair$;
commit;
