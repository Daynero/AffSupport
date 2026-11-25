-- 072 (П6): a catalog never hangs in silence (TEAM_CATALOG_HANG_ERROR_CODES), in the same order
-- as packages/shared/src/team/transport.ts; tests/team-contract.test.ts compares the two.
-- DISK_FULL: the computer running Soty ran out of disk; AGENT_STALLED: background work exists
-- and never ran a round (20261224220000 closes such rounds with it).

insert into public.team_error_codes (code) values
  ('DISK_FULL'),
  ('AGENT_STALLED')
on conflict (code) do nothing;
