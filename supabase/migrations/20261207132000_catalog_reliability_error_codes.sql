-- Additive 047 catalog reliability codes; the applied baseline remains immutable.
insert into public.team_error_codes (code) values
  ('RESTITCH_SCREEN_SELECTION_LIMIT'),
  ('CATALOG_EXPORT_TOO_LARGE'),
  ('CATALOG_UPDATE_RECONCILIATION_REQUIRED')
on conflict (code) do nothing;
