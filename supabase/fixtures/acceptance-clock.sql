-- LOCAL acceptance fixture only. Never include this file in the migration chain.
-- The guarded runner owns the surrounding transaction and singleton insert.
create table private.acceptance_tariff_clock (
  singleton boolean primary key default true check(singleton),
  namespace text not null check(namespace ~ '^acceptance-[a-z0-9][a-z0-9-]{2,63}$'),
  tariff_at timestamptz not null,
  expires_at timestamptz not null,
  installed_at timestamptz not null default clock_timestamp()
);
alter table private.acceptance_tariff_clock enable row level security;
alter table private.acceptance_tariff_clock force row level security;
revoke all on private.acceptance_tariff_clock from public, anon, authenticated, service_role;

create or replace function private.tariff_now()
returns timestamptz
language sql stable security definer
set search_path = ''
as $clock$
  select coalesce(
    (select clock.tariff_at from private.acceptance_tariff_clock clock
     where clock.singleton and clock.expires_at > pg_catalog.statement_timestamp()),
    pg_catalog.now()
  )
$clock$;
revoke all on function private.tariff_now() from public, anon, authenticated, service_role;
