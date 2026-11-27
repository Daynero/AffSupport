-- 057: Soty spaces on R2 (SPACE_STORAGE_ERROR_CODES), in the same order as
-- packages/shared/src/team/space-storage.ts; tests/team-contract.test.ts compares the two.
-- Additive: rows in public.team_error_codes only; nothing running reads them yet.

insert into public.team_error_codes (code) values
  ('STORAGE_BACKEND_MISMATCH'),
  ('R2_PILOT_REQUIRED'),
  ('CLIENT_UPDATE_REQUIRED'),
  ('STORAGE_QUOTA_EXCEEDED'),
  ('STORAGE_OBJECT_TOO_LARGE'),
  ('REVISION_CONFLICT'),
  ('UPLOAD_EXPIRED'),
  ('CHECKSUM_MISMATCH'),
  ('SPACE_ARCHIVED'),
  ('SHARE_LINK_EXPIRED'),
  ('SHARE_LINK_LIMIT')
on conflict (code) do nothing;
