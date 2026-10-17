-- The generated seed serves fresh installs; existing workspaces need the same
-- closed Launch/native error vocabulary through a forward migration.
insert into public.team_error_codes(code) values
 ('LAUNCH_VERSION_CONFLICT'),('LAUNCH_BUSY'),('LAUNCH_URL_INVALID'),
 ('LAUNCH_SUB_INVALID'),('LAUNCH_BUDGET_INVALID'),('LAUNCH_RESULT_UNCERTAIN'),
 ('LAUNCH_INTERNAL_ERROR'),('PROCESS_CANCELED'),('PROCESS_FAILED')
on conflict(code) do nothing;
