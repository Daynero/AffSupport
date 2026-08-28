-- 011 — team workspace rework: register the error codes the explorer, the
-- storage selections, the thumbnail session relay and the scope gate raise.
--
-- The contract seed (20260801090000) is regenerated from the shared package,
-- but it has already been applied wherever a team exists, so new codes are
-- added forward here. Idempotent: re-running adds nothing twice.
insert into public.team_error_codes (code) values
  ('SELECTION_UNREACHABLE'),
  ('ROOT_SELECTION_REQUIRED'),
  ('ROOT_MISSING'),
  ('TREE_TOO_LARGE'),
  ('THUMBNAIL_SESSION_EXPIRED'),
  ('RESTRICTED_SCOPE_NOT_APPROVED')
on conflict (code) do nothing;
