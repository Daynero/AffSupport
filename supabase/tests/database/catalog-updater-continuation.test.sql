begin;
select plan(13);

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

-- 20261224280000: a Drive owner's Sheets reads come from a bucket of 28 that refills 30 a minute.
select is(
  (select array_agg(public.service_take_google_sheets_reads('c0750000-0000-4000-8000-000000000001', 4))
     from generate_series(1, 7)),
  array[0, 0, 0, 0, 0, 0, 0],
  'seven updates of one owner start at once'
);
select ok(
  public.service_take_google_sheets_reads('c0750000-0000-4000-8000-000000000001', 4) between 7800 and 8100,
  'the eighth is told to wait about eight seconds, and nothing is reserved for it'
);
select ok(
  public.service_take_google_sheets_reads('c0750000-0000-4000-8000-000000000001', 4, 25000) between 7800 and 8100
  and public.service_take_google_sheets_reads('c0750000-0000-4000-8000-000000000001', 4, 25000) between 15700 and 16100,
  'a short wait is reserved: the next one queues behind it'
);
select is(
  public.service_take_google_sheets_reads('c0750000-0000-4000-8000-000000000002', 4),
  0,
  'another owner has a minute of its own'
);
select throws_ok(
  $$select public.service_take_google_sheets_reads('c0750000-0000-4000-8000-000000000001', 13)$$,
  '22023'
);
select is(
  public.service_defer_catalog_update(gen_random_uuid(), 'nobody', now()),
  false,
  'only the worker holding the lease hands a round back'
);
select ok(
  not has_function_privilege('authenticated', 'public.service_take_google_sheets_reads(uuid,integer,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.service_defer_catalog_update(uuid,text,timestamptz)', 'execute'),
  'a person can neither spend the budget nor hand rounds back'
);
select ok(
  has_function_privilege('service_role', 'public.service_defer_catalog_update(uuid,text,timestamptz)', 'execute'),
  'the worker can'
);

select * from finish();
rollback;
