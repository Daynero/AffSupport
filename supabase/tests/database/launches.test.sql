begin;
select plan(24);

select has_table('public','team_launches','Launch is a separate aggregate');
select has_table('public','team_launch_revisions','saved results have immutable revisions');
select has_table('public','team_launch_generations','generation has durable authority');
select has_table('private','launch_canceled_requests','preaccept cancellation survives lost replies');
select is_empty($$
 select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in
 ('team_launches','team_launch_revisions','team_launch_campaigns','team_launch_generations','team_launch_generation_steps')
 and (not c.relrowsecurity or not c.relforcerowsecurity)
$$,'Launch tables enable and force row level security');
select ok(not has_column_privilege('authenticated','public.team_launches','draft_config','SELECT'),
 'browser cannot read original URLs through an unprotected table projection');
select ok(not has_column_privilege('authenticated','public.team_launch_revisions','original_url','SELECT'),
 'historical original URLs require the protected RPC');
select ok(not has_column_privilege('authenticated','public.team_launch_revisions','generated_url','SELECT'),
 'historical generated URLs require the protected RPC');
select ok(not has_table_privilege('authenticated','private.launch_canceled_requests','SELECT'),
 'browser cannot enumerate request tombstones');
select ok(not has_function_privilege('authenticated',
 'public.service_accept_launch_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb)','EXECUTE'),
 'browser cannot accept generation as an arbitrary actor');
select ok(not has_function_privilege('anon',
 'public.cancel_launch_request(uuid,uuid,text,text)','EXECUTE'),
 'anonymous callers cannot cancel requests');
select ok(has_function_privilege('authenticated',
 'public.cancel_launch_request(uuid,uuid,text,text)','EXECUTE'),
 'signed in callers use the ACL checked cancellation seam');
select ok(has_function_privilege('service_role',
 'public.service_accept_launch_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb)','EXECUTE'),
 'worker accepts through the request fence');
select ok(not has_function_privilege('service_role',
 'public.service_accept_launch_generation_unfenced(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb)','EXECUTE'),
 'worker cannot bypass a canceled request');
select ok(not has_function_privilege('authenticated',
 'public.service_claim_launch_cleanup(uuid,integer)','EXECUTE'),
 'browser cannot issue provider deletion plans');
select is_empty($$
 select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in
 ('get_launch','save_launch_draft','save_launch_overrides','save_launch_working_copy','cancel_launch_request')
 and (not p.prosecdef or not ('search_path=""'=any(p.proconfig)))
$$,'protected Launch routines are definer functions with a closed search path');

select ok(not has_function_privilege('authenticated',
 'public.prepare_launch_restitch_unchecked(uuid,uuid,uuid[])','EXECUTE'),
 'browser cannot bypass durable preparation failure recording');
select ok(not has_function_privilege('authenticated',
 'public.service_settle_launch_authority_losses(integer)','EXECUTE'),
 'browser cannot mark arbitrary actors as unauthorized');
select ok(not has_function_privilege('authenticated',
 'public.service_ack_launch_upload_quiescence(uuid,bytea)','EXECUTE'),
 'browser cannot forge an upload quiescence receipt through the RPC');
select ok(not has_function_privilege('authenticated',
 'public.service_claim_launch_video_cleanup(uuid,integer)','EXECUTE'),
 'browser cannot claim a native video cleanup lease');
select ok(not has_function_privilege('authenticated',
 'public.service_list_launch_cleanup_permissions(uuid,uuid,uuid,text,text)','EXECUTE'),
 'browser cannot enumerate source permission cleanup plans');
select ok(not has_function_privilege('authenticated',
 'public.service_authorize_launch_permission_cleanup(uuid,uuid,uuid,text,text,text,uuid,text)','EXECUTE'),
 'browser cannot authorize source permission deletion');
select ok(not has_function_privilege('authenticated',
 'public.service_mark_launch_permission_cleaned(uuid,uuid,uuid,text,text,text,uuid,text)','EXECUTE'),
 'browser cannot forge a source permission deletion receipt');
select is_empty($$
 select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in
 ('service_list_launch_cleanup_permissions','service_authorize_launch_permission_cleanup',
  'service_mark_launch_permission_cleaned','service_mark_launch_permission_retained')
 and (not p.prosecdef or not ('search_path=""'=any(p.proconfig)))
$$,'source permission cleanup routines pin an empty search path');
select * from finish();
rollback;
