-- Additive bounded image recovery outcomes. No historical error catalog is rewritten.
insert into public.team_error_codes(code) values
 ('RESTITCH_SCREEN_CANDIDATES_EXHAUSTED'),
 ('RESTITCH_SCREEN_PREVIOUS_FAILURES'),
 ('RESTITCH_SCREEN_BYTE_LIMIT'),
 ('RESTITCH_SCREEN_IO_LIMIT'),
 ('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN')
on conflict(code) do nothing;
