-- A thumbnail session carries no material. Everything else may still carry none.
--
-- 20260827106000 added the thumbnail session and wrote its rule as an
-- equivalence: `(p_purpose = 'thumbnail_session') <> (p_material is null)`. Read
-- as English that is "a session has no material" — read as logic it is also
-- "every other purpose must have one", which nothing had asked for and nothing
-- announced. A finalize grant scoped to a destination folder rather than to a
-- source has been refused with INVALID_TRANSFER_GRANT ever since.
--
-- Latent rather than live: the only production caller, drive-ops, passes a
-- material for its finalize grant, so no user met this. The database test that
-- covers the documented shape did meet it, and has been failing about it since
-- the day it shipped — unheard, because the job that runs those tests could not
-- get past an earlier error.
--
-- The rule becomes one-directional, which is what it always meant. Forward-only;
-- reverse steps in ROLLBACK.md.

CREATE OR REPLACE FUNCTION private.issue_team_transfer_grant(p_token_hash bytea, p_operation uuid, p_team uuid, p_actor uuid, p_purpose text, p_material uuid, p_destination uuid, p_tool text, p_max_range_bytes integer, p_expires_at timestamp with time zone, p_max_uses integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  grant_id uuid;
begin
  if octet_length(p_token_hash) <> 32
     or p_purpose not in (
       'preview_range', 'download_range', 'process_input', 'process_output', 'finalize',
       'thumbnail_session'
     )
     or (p_purpose = 'thumbnail_session' and p_material is not null)
     or p_max_range_bytes not between 1 and 33554432
     or p_max_uses not between 1 and 10000
     or p_expires_at <= clock_timestamp() then
    raise exception 'INVALID_TRANSFER_GRANT' using errcode = '22023';
  end if;
  if p_operation is not null and not exists (
    select 1
    from public.team_operations as operation
    where operation.id = p_operation
      and operation.team_id = p_team
      and operation.actor_id = p_actor
  ) then
    raise exception 'INVALID_TRANSFER_OPERATION' using errcode = '22023';
  end if;
  insert into private.team_transfer_grants (
    token_hash, operation_id, team_id, actor_id, purpose, material_id,
    destination_folder_id, tool_id, max_range_bytes, expires_at, max_uses
  ) values (
    p_token_hash, p_operation, p_team, p_actor, p_purpose, p_material,
    p_destination, p_tool, p_max_range_bytes, p_expires_at, p_max_uses
  ) returning id into grant_id;
  return grant_id;
end;
$function$;
