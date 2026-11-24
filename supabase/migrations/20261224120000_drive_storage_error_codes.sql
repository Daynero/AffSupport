-- 2026-11-24: a full Google storage (TEAM_DRIVE_STORAGE_ERROR_CODES), in the same order as
-- packages/shared/src/team/transport.ts; tests/team-contract.test.ts compares the two.

insert into public.team_error_codes (code) values
  ('DRIVE_STORAGE_FULL')
on conflict (code) do nothing;
