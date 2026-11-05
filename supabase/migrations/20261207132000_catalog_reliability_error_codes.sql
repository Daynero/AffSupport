-- Additive 047 catalog reliability codes; the applied baseline remains immutable.
insert into public.team_error_codes (code) values
  ('RESTITCH_SCREEN_SELECTION_LIMIT')
on conflict (code) do nothing;
