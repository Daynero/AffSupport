-- Keep the private restitch folder registry under the same forced RLS boundary
-- as every other team table. Only security-definer service functions use it.
alter table private.team_restitched_folders enable row level security;
alter table private.team_restitched_folders force row level security;
