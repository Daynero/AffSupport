begin;
select plan(5);

-- 2026-11-25: the catalog updater's worker dispatches its own next tick when rounds are still
-- waiting (20261224250000). Only the worker may ask; with nothing due the gate sends nothing.

select has_function('public', 'service_continue_catalog_updater', array[]::text[]);
select ok(
  has_function_privilege('service_role', 'public.service_continue_catalog_updater()', 'execute'),
  'the worker may dispatch its next tick'
);
select ok(
  not has_function_privilege('authenticated', 'public.service_continue_catalog_updater()', 'execute')
  and not has_function_privilege('anon', 'public.service_continue_catalog_updater()', 'execute'),
  'a person cannot start the worker'
);

-- Nothing due anywhere: the same gate as the minute's schedule answers null and queues nothing.
update public.team_catalog_updater_items set round_due_at = null, update_interval = null;
delete from private.catalog_update_reconciliations;
update public.team_catalog_restitch_copies set next_delete_at = now() + interval '1 day'
 where role = 'retired';
create temp table sent_before as select count(*) as n from net.http_request_queue;
select is(
  public.service_continue_catalog_updater(),
  null::bigint,
  'with nothing due, nothing is dispatched'
);
select is(
  (select count(*) from net.http_request_queue),
  (select n from sent_before),
  'and no request is queued'
);

select * from finish();
rollback;
