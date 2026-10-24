-- 036: own-row invalidation metadata obeys the same forced-RLS boundary as
-- every other team table, including non-bypass table owners.
begin;
alter table public.team_membership_access_signals force row level security;
commit;
