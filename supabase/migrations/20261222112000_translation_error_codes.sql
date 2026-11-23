-- 063: the closed error codes of transcript translation (TEAM_TRANSLATION_ERROR_CODES), in the same
-- order as packages/shared/src/team/transport.ts; tests/team-contract.test.ts compares the two.

insert into public.team_error_codes (code) values
  ('TRANSLATION_ALLOWANCE_EXCEEDED'),
  ('TRANSLATION_SOURCE_UNAVAILABLE'),
  ('TRANSLATION_UNAVAILABLE'),
  ('TRANSLATION_REFUSED'),
  ('TRANSLATION_FAILED'),
  ('TRANSLATION_TIMEOUT')
on conflict (code) do nothing;
