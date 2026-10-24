begin;
select plan(3);
select has_function('private','process_output_cleanup_due',array[]::text[],'headless cleanup has a durable due predicate');
select ok(not has_function_privilege('authenticated','private.process_output_cleanup_due()','execute'),'client cannot inspect global cleanup queue');
select is(private.process_output_cleanup_due(),false,'empty output queue does not dispatch work');
select * from finish();
rollback;
