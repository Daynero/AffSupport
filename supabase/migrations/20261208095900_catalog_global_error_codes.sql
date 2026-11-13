-- 052 additive closed vocabulary. Existing applied catalog code migrations stay immutable.
insert into public.team_error_codes(code) values
  ('GLOBAL_IMAGE_POOL_UNAVAILABLE'),
  ('GLOBAL_IMAGE_READINESS_UNKNOWN'),
  ('GLOBAL_IMAGE_ALLOCATION_UNKNOWN'),
  ('GLOBAL_IMAGE_SETTINGS_RETIRED'),
  ('GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED'),
  ('GLOBAL_IMAGE_POLICY_CONFLICT'),
  ('GLOBAL_IMAGE_CLEANUP_UNKNOWN')
on conflict(code) do nothing;
