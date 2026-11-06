-- Additive command recovery codes; applied error catalogs remain immutable.
insert into public.team_error_codes (code) values
  ('CATALOG_COMMAND_STORAGE_UNAVAILABLE'),
  ('CATALOG_COMMAND_UNSUPPORTED')
on conflict (code) do nothing;
