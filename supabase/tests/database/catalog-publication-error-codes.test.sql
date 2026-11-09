begin;
select plan(2);
select is((select count(*)::integer from public.team_error_codes where code in('CATALOG_PUBLICATION_PENDING','CATALOG_WRITE_UNSUPPORTED')),2,'additive publication vocabulary is installed by the new forward batch');
select is((select count(*)::integer from public.team_error_codes where code='CATALOG_STOP_TARGET_UNKNOWN'),1,'historical actor-bound mutation vocabulary remains installed once');
select * from finish();
rollback;
