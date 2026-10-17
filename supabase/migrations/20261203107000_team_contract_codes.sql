-- Existing databases do not replay the generated seed when the shared closed
-- code list grows. Keep the hosted registry aligned for already installed spaces.
insert into public.team_error_codes(code) values
  ('ACTIVE_LAUNCH'),
  ('ACCOUNT_ARCHIVED'),
  ('ACCOUNT_HAS_HISTORY'),
  ('UNVERIFIED_UPLOAD'),
  ('SEATS_FULL'),
  ('SEATS_IN_USE'),
  ('SPACE_BLOCKED'),
  ('TARIFF_BOUND'),
  ('LEGACY_SPACES_REMAIN'),
  ('TARIFF_DATE_INVALID')
on conflict (code) do nothing;
