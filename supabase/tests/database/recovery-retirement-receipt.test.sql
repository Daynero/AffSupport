-- T167: prepared contract tests; run only through the disposable database runner.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(34);
select has_function('public','retire_team_recovery_installation_observed',array['uuid','uuid'],'observed retirement has only installation and attempt inputs');
select has_table('private','team_recovery_retirement_attempts','authoritative retirement receipts exist');
select ok(not has_function_privilege('anon','public.retire_team_recovery_installation_observed(uuid,uuid)','EXECUTE'),'anonymous retirement is denied');
select ok(has_function_privilege('authenticated','public.retire_team_recovery_installation_observed(uuid,uuid)','EXECUTE'),'the authenticated actor can retire its installation');
select ok(not has_function_privilege('service_role','public.retire_team_recovery_installation_observed(uuid,uuid)','EXECUTE'),'service role cannot impersonate browser retirement');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='private.team_recovery_retirement_attempts'::regclass),'receipt storage forces RLS');
select ok(not has_table_privilege('authenticated','private.team_recovery_retirement_attempts','INSERT,UPDATE,DELETE'),'browser clients cannot forge or delete receipts');
select ok(not has_table_privilege('service_role','private.team_recovery_retirement_attempts','INSERT,UPDATE,DELETE'),'service clients cannot forge or delete receipts');
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('e1670000-0000-4000-8000-000000000001','authenticated','authenticated','receipt-a@acceptance.test.invalid','{}','{}'),
 ('e1670000-0000-4000-8000-000000000002','authenticated','authenticated','receipt-b@acceptance.test.invalid','{}','{}');
select set_config('request.jwt.claim.sub','e1670000-0000-4000-8000-000000000001',true);
set local role authenticated;
select is(public.retire_team_recovery_installation_observed('e1670000-0000-4000-8000-000000000003','e1670000-0000-4000-8000-000000000004')->>'state','server_confirmed','empty actor scope is confirmed');
select is(public.retire_team_recovery_installation_observed('e1670000-0000-4000-8000-000000000003','e1670000-0000-4000-8000-000000000004')->>'retiredCount','0','the same attempt returns its original empty-scope receipt');
select throws_ok($$select public.retire_team_recovery_installation_observed('e1670000-0000-4000-8000-000000000005','e1670000-0000-4000-8000-000000000004')$$,'22023','INVALID_INPUT','one attempt cannot be redirected to another installation');
reset role;
select is((select count(*) from private.team_recovery_retirement_attempts where actor_id='e1670000-0000-4000-8000-000000000001'),1::bigint,'replay produces only one receipt');
select set_config('request.jwt.claim.sub','e1670000-0000-4000-8000-000000000002',true);
set local role authenticated;
select is(public.retire_team_recovery_installation_observed('e1670000-0000-4000-8000-000000000003','e1670000-0000-4000-8000-000000000004')->>'state','server_confirmed','another actor has an independent attempt namespace');
reset role;
select is((select count(distinct actor_id) from private.team_recovery_retirement_attempts where attempt_id='e1670000-0000-4000-8000-000000000004'),2::bigint,'same nonce does not collide across actors');
select ok(has_table_privilege('service_role','public.analytics_recovery_retirement','SELECT'),'diagnostic projection is readable by its trusted reader');
select ok(not has_table_privilege('service_role','public.analytics_recovery_retirement','INSERT,UPDATE,DELETE'),'diagnostic projection cannot mutate receipts');
insert into public.admin_users(user_id) values('e1670000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub','e1670000-0000-4000-8000-000000000001',true);
do $setup$ begin
 perform public.admin_grant_space_tariff('receipt-a@acceptance.test.invalid','lead',private.kyiv_today()+30,0);
 perform public.create_team('Receipt replay synthetic');
end $setup$;
insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)
 select id,'e1670000-0000-4000-8000-000000000001','e1670000-0000-4000-8000-000000000003',decode(repeat('67',32),'hex')
 from public.teams where owner_id='e1670000-0000-4000-8000-000000000001' and name='Receipt replay synthetic';
set local role authenticated;
select is(public.retire_team_recovery_installation_observed('e1670000-0000-4000-8000-000000000003','e1670000-0000-4000-8000-000000000004')->>'retiredCount','0','cached attempt never revokes a subsequently created delegation');
reset role;
select is((select count(*) from private.team_recovery_delegations where actor_id='e1670000-0000-4000-8000-000000000001' and revoked_at is null),1::bigint,'fresh delegation survives a cached attempt');
set local role authenticated;
select is(public.retire_team_recovery_installation_observed('e1670000-0000-4000-8000-000000000003','e1670000-0000-4000-8000-000000000006')->>'retiredCount','1','a new explicit attempt retires the current delegation');
reset role;
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('e1670000-0000-4000-8000-000000000007','authenticated','authenticated','receipt-c@acceptance.test.invalid','{}','{}');
select set_config('request.jwt.claim.sub','e1670000-0000-4000-8000-000000000007',true);
set local role authenticated;
select lives_ok($budget$select public.retire_team_recovery_installation_observed('e1670000-0000-4000-8000-000000000003',gen_random_uuid()) from generate_series(1,60)$budget$,'bounded new-attempt budget allows sixty distinct attempts');
select throws_ok($budget$select public.retire_team_recovery_installation_observed('e1670000-0000-4000-8000-000000000003',gen_random_uuid())$budget$,'P0001','RATE_LIMITED','the next distinct attempt is rate limited');
reset role;
select set_config('test.retirement_cached_attempt',(select min(attempt_id::text) from private.team_recovery_retirement_attempts where actor_id='e1670000-0000-4000-8000-000000000007'),true);
set local role authenticated;
select is(public.retire_team_recovery_installation_observed('e1670000-0000-4000-8000-000000000003',current_setting('test.retirement_cached_attempt')::uuid)->>'state','server_confirmed','cached retry bypasses the new-attempt rate charge');
reset role;
select is((select count(*) from private.team_recovery_retirement_attempts where actor_id='e1670000-0000-4000-8000-000000000007'),60::bigint,'refused attempts create no receipt');
update private.team_recovery_retirement_rates set window_start=clock_timestamp()-interval '61 seconds' where actor_id='e1670000-0000-4000-8000-000000000007';
set local role authenticated;
select is(public.retire_team_recovery_installation_observed('e1670000-0000-4000-8000-000000000003',gen_random_uuid())->>'state','server_confirmed','real elapsed time resets the attempt budget');
reset role;
select is((select attempts from private.team_recovery_retirement_rates where actor_id='e1670000-0000-4000-8000-000000000007'),1,'a reset window starts with one attempt');
insert into private.team_recovery_retirement_attempts(actor_id,attempt_id,installation_id,retired_count,confirmed_at)
 select 'e1670000-0000-4000-8000-000000000007',gen_random_uuid(),'e1670000-0000-4000-8000-000000000003',0,clock_timestamp()-interval '31 days' from generate_series(1,201);
select lives_ok('select private.sweep_workspace_recovery()','the normal lifecycle sweep also performs receipt retention');
select is((select count(*) from private.team_recovery_retirement_attempts where actor_id='e1670000-0000-4000-8000-000000000007' and confirmed_at<clock_timestamp()-interval '30 days'),101::bigint,'one sweep deletes at most one hundred expired receipts');
select ok(private.task_cleanup_coverage_verified(),'typed identity ledgers preserve complete material-reference coverage');
alter table private.team_recovery_retirement_attempts add column future_content jsonb;
select ok(not private.task_cleanup_coverage_verified(),'future JSON content cancels the identity-only exemption');
alter table private.team_recovery_retirement_attempts drop column future_content;
select ok(private.task_cleanup_coverage_verified(),'coverage restores after the unknown JSON column is removed');
alter table private.team_recovery_retirement_attempts add constraint retirement_test_material_fk foreign key(installation_id) references public.team_materials(id) not valid;
select ok(not private.task_cleanup_coverage_verified(),'a material FK cancels exemption even on an otherwise approved column');
alter table private.team_recovery_retirement_attempts drop constraint retirement_test_material_fk;
select ok(private.task_cleanup_coverage_verified(),'coverage restores after the material FK is removed');
alter table private.team_recovery_retirement_rates add column future_reference uuid;
select ok(not private.task_cleanup_coverage_verified(),'an unregistered scalar reference also cancels exemption');
alter table private.team_recovery_retirement_rates drop column future_reference;
select ok(private.task_cleanup_coverage_verified(),'coverage restores after an unknown scalar column is removed');
select * from finish();
rollback;
