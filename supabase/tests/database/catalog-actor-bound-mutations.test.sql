begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(42);
create temporary table actor_bound_contract(signature text, arguments text);
insert into actor_bound_contract values
 ('public.patch_team_catalog_update_profile_as_actor(uuid,uuid,bigint,jsonb,uuid)',
  $$'47000000-0000-4000-8000-000000000001','47000000-0000-4000-8000-000000000002',1,'{}'::jsonb$$),
 ('public.cancel_team_catalog_update_attempt_as_actor(uuid,uuid,timestamptz,uuid,uuid)',
  $$'47000000-0000-4000-8000-000000000001','47000000-0000-4000-8000-000000000002',now(),null::uuid$$),
 ('public.set_team_catalog_updater_restitch_as_actor(uuid,boolean,uuid)',
  $$'47000000-0000-4000-8000-000000000001',true$$),
 ('public.set_team_catalog_updater_refresh_images_as_actor(uuid,boolean,uuid)',
  $$'47000000-0000-4000-8000-000000000001',true$$),
 ('public.set_team_catalog_updater_refresh_texts_as_actor(uuid,boolean,uuid)',
  $$'47000000-0000-4000-8000-000000000001',true$$),
 ('public.set_team_catalog_updater_random_link_variation_as_actor(uuid,boolean,uuid)',
  $$'47000000-0000-4000-8000-000000000001',true$$),
 ('public.set_team_catalog_updater_grow_as_actor(uuid,boolean,uuid)',
  $$'47000000-0000-4000-8000-000000000001',true$$);
select ok(has_function_privilege('authenticated',signature,'execute'),signature||' allows authenticated RPC') from actor_bound_contract;
select ok(not has_function_privilege('anon',signature,'execute'),signature||' refuses anonymous execution') from actor_bound_contract;
select ok((select prosecdef from pg_proc where oid=signature::regprocedure),signature||' uses guarded definer') from actor_bound_contract;
select ok((select array_to_string(proconfig,',') = 'search_path=""' from pg_proc where oid=signature::regprocedure),signature||' has empty search path') from actor_bound_contract;
select set_config('request.jwt.claim.sub','',true);
select throws_ok('select '||split_part(signature,'(',1)||'('||arguments||',''47000000-0000-4000-8000-000000000081'')',
 '42501','PERMISSION_DENIED',signature||' refuses absent actor before delegation') from actor_bound_contract;
select set_config('request.jwt.claim.sub','47000000-0000-4000-8000-000000000081',true);
select throws_ok('select '||split_part(signature,'(',1)||'('||arguments||',''47000000-0000-4000-8000-000000000082'')',
 '42501','PERMISSION_DENIED',signature||' refuses changed actor before delegation') from actor_bound_contract;
select * from finish();
rollback;
