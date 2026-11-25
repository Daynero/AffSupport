-- 072 (catalog never hangs silently), agent package П4.
--
-- 1. The desktop's background work stopping on this computer used to be invisible to the server:
--    the worker parked itself as «blocked» (retry_exhausted, a Drive refusal) and asked again
--    once an hour, and the round read «Чекає на комп'ютерний агент…» for a day. The desktop now
--    sends its local state with the recovery probe (`localState`); the delegation keeps the last
--    one, and clears it when the desktop says it works again. The registry (П1) reads
--    `agent_block_code` as the round's wait reason.
--    An older desktop never sends the field and the columns stay null; an older server ignores
--    the field (its probe passed `{}` to this function).
--
-- 2. A catalog variant's closure accepts three more codes the desktop now reports instead of
--    PROCESS_FAILED or silence: DISK_FULL, NEEDS_REAUTH, DRIVE_STORAGE_FULL; the set's failure
--    code reads them too. A desktop that meets an older closure falls back to PROCESS_FAILED.
--
-- No jsonb and no foreign key: the recovery tables stay outside the cleanup-fence inventory.
-- Rollback: drop the three columns and `private.record_recovery_agent_state`, and restore the
-- three patched bodies from 20261224100000 / 20261207180000 / 20261207168000. Desktops keep
-- sending the field; an unpatched probe ignores it.

alter table private.team_recovery_delegations
 add column agent_block_reason text check(agent_block_reason ~ '^[a-z_]{1,48}$'),
 add column agent_block_code text check(agent_block_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
 add column agent_block_at timestamptz,
 add constraint team_recovery_delegations_agent_block_shape check(
  (agent_block_code is null and agent_block_reason is null and agent_block_at is null)
  or (agent_block_code is not null and agent_block_reason is not null and agent_block_at is not null));

comment on column private.team_recovery_delegations.agent_block_code is
 '072: why this computer''s background work stopped, as the desktop reported it with its probe (null: working).';

-- Called only after the probe itself was authorized (current refresh hash, rate limit). A state
-- the desktop sends malformed is ignored, never an error: a probe must keep answering.
create function private.record_recovery_agent_state(p_delegation uuid,p_hash bytea,p_state jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_delegation is null or p_state is null or jsonb_typeof(p_state)<>'object' then return; end if;
 if p_state->>'stage'='clear' then
  update private.team_recovery_delegations set agent_block_reason=null,agent_block_code=null,agent_block_at=null
   where id=p_delegation and refresh_hash=p_hash and agent_block_code is not null;
 elsif p_state->>'stage'='blocked'
  and coalesce(p_state->>'reason','') ~ '^[a-z_]{1,48}$'
  and coalesce(p_state->>'code','') ~ '^[A-Z][A-Z0-9_]{1,63}$' then
  update private.team_recovery_delegations
   set agent_block_reason=p_state->>'reason',agent_block_code=p_state->>'code',agent_block_at=clock_timestamp()
   where id=p_delegation and refresh_hash=p_hash;
 end if;
end;$$;
revoke all on function private.record_recovery_agent_state(uuid,bytea,jsonb) from public,anon,authenticated;

do $patch$
declare d text;
begin
 select pg_get_functiondef('public.service_team_recovery(text,bytea,jsonb)'::regprocedure) into d;
 if strpos(d,$find$ if p_action not in ('delegate','redeem') then
  return private.service_team_recovery_before_automatic(p_action,p_hash,p_input);
 end if;$find$)=0 then raise exception 'RECOVERY_AGENT_STATE_PATCH_MISSING'; end if;
 d:=replace(d,$find$ if p_action not in ('delegate','redeem') then
  return private.service_team_recovery_before_automatic(p_action,p_hash,p_input);
 end if;$find$,$replace$ if p_action='probe' and p_input ? 'localState' then
  receipt:=private.service_team_recovery_before_automatic(p_action,p_hash,p_input);
  perform private.record_recovery_agent_state((receipt->>'delegationId')::uuid,p_hash,p_input->'localState');
  return receipt;
 end if;
 if p_action not in ('delegate','redeem') then
  return private.service_team_recovery_before_automatic(p_action,p_hash,p_input);
 end if;$replace$);
 execute d;

 select pg_get_functiondef('public.service_complete_catalog_video_variant(uuid,bytea,uuid,integer,integer,uuid,uuid,text,text)'::regprocedure) into d;
 if strpos(d,$find$'PROCESS_FAILED','TOO_LARGE')))then raise exception 'INVALID_INPUT'$find$)=0
 then raise exception 'CATALOG_VARIANT_CLOSURE_CODES_PATCH_MISSING'; end if;
 d:=replace(d,$find$'PROCESS_FAILED','TOO_LARGE')))then raise exception 'INVALID_INPUT'$find$,
  $replace$'PROCESS_FAILED','TOO_LARGE','DISK_FULL','NEEDS_REAUTH','DRIVE_STORAGE_FULL')))then raise exception 'INVALID_INPUT'$replace$);
 execute d;

 select pg_get_functiondef('private.catalog_video_failure_code(uuid)'::regprocedure) into d;
 if strpos(d,$find$'PROCESS_FAILED','TOO_LARGE')order by$find$)=0
 then raise exception 'CATALOG_VIDEO_FAILURE_CODES_PATCH_MISSING'; end if;
 d:=replace(d,$find$'PROCESS_FAILED','TOO_LARGE')order by$find$,
  $replace$'PROCESS_FAILED','TOO_LARGE','DISK_FULL','NEEDS_REAUTH','DRIVE_STORAGE_FULL')order by$replace$);
 execute d;
end $patch$;
