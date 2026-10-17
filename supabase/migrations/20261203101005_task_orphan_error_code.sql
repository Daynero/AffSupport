-- The exact-operation marker rejects unproven uploads with a closed machine code.
insert into public.team_error_codes(code) values ('UNVERIFIED_UPLOAD')
on conflict (code) do nothing;
