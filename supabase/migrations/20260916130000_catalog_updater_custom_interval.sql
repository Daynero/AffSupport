-- Feature 023 — the catalog updater's own interval, in whole hours.
--
-- Besides 1 hour, 1 day and 1 week, an updater may run every N hours (1–720, up to 30 days), stored
-- as 'Nh'. The presets keep their spelling, so nothing already running changes. Additive;
-- reverse steps in ROLLBACK.md.

create or replace function private.catalog_updater_interval(p_interval text)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case
    when p_interval = '1h' then interval '1 hour'
    when p_interval = '1d' then interval '1 day'
    when p_interval = '1w' then interval '7 days'
    when p_interval ~ '^[1-9][0-9]{0,2}h$' and left(p_interval, -1)::integer <= 720
      then make_interval(hours => left(p_interval, -1)::integer)
  end;
$$;

revoke all on function private.catalog_updater_interval(text) from public;

alter table public.team_catalog_updaters
  drop constraint if exists team_catalog_updaters_interval_check;
alter table public.team_catalog_updaters
  add constraint team_catalog_updaters_interval_check
  check (private.catalog_updater_interval(update_interval) is not null);
