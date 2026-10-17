-- Expired tickets cannot authorize a transfer. Keep one additional day for
-- diagnosis and drain in small transactions; never delete operations/materials.
-- Authorized server repair: at most 500 expired tickets per five-minute run.
create index team_transfer_grants_retention_idx
  on private.team_transfer_grants (expires_at, id);
-- The full leading expiry key also serves the old unrevoked-only lookups.
-- Replace their ~30 MB index instead of maintaining two expiry indexes.
drop index if exists private.team_transfer_grants_expiry_idx;

create or replace function private.cleanup_team_transfer_grants(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
  cutoff timestamptz := pg_catalog.clock_timestamp() - interval '1 day';
begin
  with victims as (
    select g.id from private.team_transfer_grants g
    where g.expires_at < cutoff
    order by g.expires_at, g.id
    limit least(greatest(coalesce(p_limit, 500), 1), 500)
    for update skip locked
  )
  delete from private.team_transfer_grants g using victims v where g.id = v.id;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function private.cleanup_team_transfer_grants(integer)
  from public, anon, authenticated, service_role;

comment on function private.cleanup_team_transfer_grants(integer) is
  'Operator-only: at most 500 tickets expired over a day ago; no live grants or user materials.';


do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'soty-transfer-grants-retention', '3-58/5 * * * *',
      'select private.cleanup_team_transfer_grants(500);'
    );
  end if;
end;
$$;
