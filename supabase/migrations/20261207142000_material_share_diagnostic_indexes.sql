begin;
-- Bounded diagnostic reads must not scan every team's retained request ledger.
create index material_share_actor_observation on private.team_material_share_intents(actor_id,created_at desc,id);
create index material_share_command_observation on private.team_material_share_intents((split_part(request_key,':',3)::uuid),created_at desc,id);
create index material_share_observation on private.team_material_share_intents(created_at desc,id);
commit;
