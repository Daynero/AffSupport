-- 057 M1 (T027): the access epoch the space-read Worker checks on every read (research R4,
-- contracts/storage-api.md «Worker space-read»).
--
-- Additive: one service function. The Worker calls it with the service key and caches the
-- answer for at most 30 seconds, so raising teams.access_epoch (20261226120000) revokes every
-- read grant already issued within that window. It answers text, never a JSON number, so a
-- bigint keeps its precision; null when the space is not an active R2 space (the Worker then
-- refuses the read).

create function public.service_space_read_epoch(p_team uuid) returns text
language sql stable security definer set search_path = '' as $$
  select team.access_epoch::text from public.teams team
  where team.id = p_team and team.status = 'active' and team.storage_backend = 'r2';
$$;

revoke all on function public.service_space_read_epoch(uuid) from public, anon, authenticated;
grant execute on function public.service_space_read_epoch(uuid) to service_role;
