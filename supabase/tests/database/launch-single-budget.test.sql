begin;
select plan(9);
-- Exercise the real shared workspace/offer trigger on isolated synthetic profiles.
create temporary table budget_profiles(team_id uuid, config jsonb, sub_config jsonb default '{"schemaVersion":1,"sub1":[],"sub2":[],"sub3":[]}');
create trigger validate_budget_profile before insert on budget_profiles for each row execute function private.validate_launch_defaults_row();
select lives_ok($$insert into budget_profiles(config) values('{"budgetMode":"single","campaignCount":100,"maxBudget":1,"budgets":null}')$$,'100 campaigns can share a one-dollar amount');
select lives_ok($$insert into budget_profiles(config) values('{"budgetMode":"single","campaignCount":1,"maxBudget":999999,"budgets":null}')$$,'single amount accepts the upper bound');
select throws_ok($$insert into budget_profiles(config) values('{"budgetMode":"single","maxBudget":0,"budgets":null}')$$,'22023','INVALID_INPUT','zero rejected');
select throws_ok($$insert into budget_profiles(config) values('{"budgetMode":"single","maxBudget":1.5,"budgets":null}')$$,'22023','INVALID_INPUT','fraction rejected');
select throws_ok($$insert into budget_profiles(config) values('{"budgetMode":"single","maxBudget":20,"minBudget":10,"budgets":null}')$$,'22023','INVALID_INPUT','hidden minimum rejected');
select throws_ok($$insert into budget_profiles(config) values('{"budgetMode":"single","maxBudget":20,"budgets":[20,20]}')$$,'22023','INVALID_INPUT','contradictory array rejected');
select throws_ok($$insert into budget_profiles(config) values('{"budgetMode":"single","budgets":null}')$$,'22023','INVALID_INPUT','missing amount rejected');
select throws_ok($$insert into budget_profiles(config) values('{"budgetMode":"manual","campaignCount":2,"maxBudget":20,"budgets":[20,20]}')$$,'22023','INVALID_INPUT','manual still requires increasing budgets');
select throws_ok($$insert into budget_profiles(config) values('{"budgetMode":"auto","campaignCount":2,"minBudget":20,"maxBudget":20,"budgets":null}')$$,'22023','INVALID_INPUT','automatic still requires enough range');
select * from finish();
rollback;
