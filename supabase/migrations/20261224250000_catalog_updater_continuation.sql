-- The catalog updater's worker hands itself the next tick when rounds are still waiting.
--
-- Production 2026-11-25: a manual run updates at most three catalogs in one request (an
-- eight-second budget, three at a time), and the rest waited for the minute's schedule.
-- Six catalogs of one run: three after ~15 s, three more after 30–60 s of nothing. The
-- worker now asks for the next tick at once when its last claim came back full and it
-- updated something; the dispatch goes through the same gate as the schedule (due work,
-- the lease cap), so an empty queue answers null and nothing is sent.

create or replace function public.service_continue_catalog_updater()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- pg_net sends after this transaction commits; the durable rounds and the minute's
  -- schedule stay the recovery path when it cannot.
  return private.invoke_catalog_updater_worker();
exception when others then
  return null;
end;
$$;

revoke all on function public.service_continue_catalog_updater() from public, anon, authenticated;
grant execute on function public.service_continue_catalog_updater() to service_role;
