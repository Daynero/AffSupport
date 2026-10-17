-- Only idle landing-image grants minted by the HMAC issuer are reusable.
-- Legacy random tickets, uploads, used/revoked tickets and operations are untouched.
alter table private.team_transfer_grants add column reuse_key text;
create index team_transfer_grants_idle_landing_idx
  on private.team_transfer_grants (team_id, actor_id, material_id, tool_id, reuse_key, expires_at desc)
  where reuse_key is not null and uses = 0 and revoked_at is null;

create or replace function public.issue_landing_preview_grant(
  p_id uuid, p_token_hash bytea, p_reuse_key text,
  p_team uuid, p_actor uuid, p_material uuid, p_tool text,
  p_max_range_bytes integer
)
returns table (grant_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  existing private.team_transfer_grants%rowtype;
  expiry timestamptz;
begin
  if p_id is null or p_token_hash is null or octet_length(p_token_hash) <> 32
     or p_reuse_key is null or p_reuse_key !~ '^[a-f0-9]{64}$'
     or p_team is null or p_actor is null or p_material is null
     or p_tool is null or p_tool !~ '^landing-render:[a-f0-9-]{36}:[0-9]+$'
     or p_max_range_bytes is null or p_max_range_bytes not between 1 and 33554432 then
    raise exception 'INVALID_TRANSFER_GRANT' using errcode = '22023';
  end if;
  if not private.can(p_team, 'view', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  -- Serialize issuance for this exact authority/artifact. Consumption retains
  -- its existing row lock and eight-use budget; neither expiry nor uses reset.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_team::text || ':' || p_actor::text || ':' || p_material::text || ':' || p_tool, 0));
  select g.* into existing from private.team_transfer_grants g
  where g.team_id = p_team and g.actor_id = p_actor and g.material_id = p_material
    and g.tool_id = p_tool and g.reuse_key = p_reuse_key
    and g.purpose = 'preview_range' and g.operation_id is null
    and g.destination_folder_id is null and g.max_uses = 8
    and g.max_range_bytes = p_max_range_bytes
    and g.uses = 0 and g.revoked_at is null
    and g.expires_at > pg_catalog.clock_timestamp() + interval '2 minutes'
  order by g.expires_at desc limit 1 for update;
  if existing.id is not null then
    return query select existing.id, existing.expires_at;
    return;
  end if;
  expiry := pg_catalog.clock_timestamp() + interval '20 minutes';
  insert into private.team_transfer_grants (
    id, token_hash, team_id, actor_id, purpose, material_id,
    tool_id, max_range_bytes, expires_at, max_uses, reuse_key
  ) values (
    p_id, p_token_hash, p_team, p_actor, 'preview_range', p_material,
    p_tool, p_max_range_bytes, expiry, 8, p_reuse_key
  );
  return query select p_id, expiry;
end;
$$;
revoke all on function public.issue_landing_preview_grant(uuid, bytea, text, uuid, uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.issue_landing_preview_grant(uuid, bytea, text, uuid, uuid, uuid, text, integer)
  to service_role;
