begin;
select plan(10);

-- 057 T120 (20261226370000): a member's Soty takes an R2 space's picture jobs in the background,
-- with the claim credential of its background delegation. The credential must be a current claim
-- credential of a live delegation, the space R2, the agent of workspace contract 3, and the member
-- still allowed to process there. The hot recovery function stays as it was.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05791370-0000-4000-8000-000000000001','authenticated','authenticated','bg-owner@test.invalid','{}','{}'),
 ('05791370-0000-4000-8000-000000000002','authenticated','authenticated','bg-viewer@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values
 ('05791370-0000-4000-8000-000000000001',100000),
 ('05791370-0000-4000-8000-000000000002',100000);

create temporary table seen(label text, value jsonb);
create function pg_temp.team() returns uuid language sql as $$ select (value->>'teamId')::uuid from seen where label='space' $$;
create function pg_temp.hash(p_label text) returns bytea language sql as $$ select extensions.digest(p_label, 'sha256') $$;
-- A delegation of `p_actor` in `p_team` and one credential of it.
create function pg_temp.credential(p_label text, p_team uuid, p_actor uuid, p_audience text default 'claim',
  p_expires interval default interval '5 minutes') returns void language plpgsql as $$
declare v_delegation uuid;
begin
  insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)
  values (p_team, p_actor, gen_random_uuid(), pg_temp.hash('refresh:'||p_label)) returning id into v_delegation;
  insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at,operation_id,job_id)
  values (pg_temp.hash(p_label), v_delegation, 1, p_audience, clock_timestamp() + p_expires,
    case when p_audience = 'execute' then gen_random_uuid() end, case when p_audience = 'execute' then gen_random_uuid() end);
  insert into seen values (p_label, jsonb_build_object('delegationId', v_delegation));
end $$;
create function pg_temp.actor(p_label text, p_contract integer default 3) returns jsonb language sql as $$
  select public.service_space_recovery_derivative_actor(pg_temp.hash(p_label),
    case when p_contract is null then '{}'::jsonb else jsonb_build_object('teamWorkspaceContract', p_contract) end) $$;

insert into seen select 'space', public.service_create_r2_space('05791370-0000-4000-8000-000000000001','Background space','bg-space-key-0001');
insert into public.team_members(team_id,user_id,base_role) values
 (pg_temp.team(),'05791370-0000-4000-8000-000000000002','viewer') on conflict do nothing;
insert into public.teams(id,name,owner_id) values ('05791370-0000-4000-8000-0000000000d1','Drive space','05791370-0000-4000-8000-000000000001');

select pg_temp.credential('owner-claim', pg_temp.team(), '05791370-0000-4000-8000-000000000001');
select is(pg_temp.actor('owner-claim')->>'actorId', '05791370-0000-4000-8000-000000000001',
 'a claim credential of an R2 space names its member');
select is(pg_temp.actor('owner-claim')->>'teamId', pg_temp.team()::text, 'and its space');
select throws_ok($$select pg_temp.actor('owner-claim', null)$$, 'AGENT_UPDATE_REQUIRED',
 'an agent that does not say contract 3 is told to update');

select pg_temp.credential('owner-execute', pg_temp.team(), '05791370-0000-4000-8000-000000000001', 'execute');
select throws_ok($$select pg_temp.actor('owner-execute')$$, 'AUTH_REQUIRED', 'a run''s execute credential is not a claim one');
select pg_temp.credential('owner-expired', pg_temp.team(), '05791370-0000-4000-8000-000000000001', 'claim', interval '-1 second');
select throws_ok($$select pg_temp.actor('owner-expired')$$, 'AUTH_REQUIRED', 'an expired credential opens nothing');
update private.team_recovery_delegations set revoked_at = now(), version = version + 1
 where id = (select (value->>'delegationId')::uuid from seen where label='owner-claim');
select throws_ok($$select pg_temp.actor('owner-claim')$$, 'AUTH_REQUIRED', 'nor one of a revoked delegation');

select pg_temp.credential('viewer-claim', pg_temp.team(), '05791370-0000-4000-8000-000000000002');
select throws_ok($$select pg_temp.actor('viewer-claim')$$, 'PERMISSION_DENIED', 'a member who may not process takes no jobs');
select pg_temp.credential('drive-claim', '05791370-0000-4000-8000-0000000000d1', '05791370-0000-4000-8000-000000000001');
select throws_ok($$select pg_temp.actor('drive-claim')$$, 'STORAGE_BACKEND_MISMATCH', 'a Drive space has no such jobs');

select ok(not has_function_privilege('authenticated', 'public.service_space_recovery_derivative_actor(bytea,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.service_space_recovery_derivative_actor(bytea,jsonb)', 'execute'),
 'only the service may ask');
-- The Drive path's one door is as it was: no derivative branch was added to it.
select ok(strpos(pg_get_functiondef('public.service_team_recovery(text,bytea,jsonb)'::regprocedure), 'derivative') = 0
  and strpos(pg_get_functiondef('public.service_team_recovery(text,bytea,jsonb)'::regprocedure), 'space_storage_recovery_backend') > 0,
 'service_team_recovery is untouched');

select * from finish();
rollback;
