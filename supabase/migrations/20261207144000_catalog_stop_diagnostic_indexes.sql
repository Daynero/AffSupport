begin;
-- Bounded Stop lookup by observed attempt, original request, or initiating actor.
create index analytics_catalog_stop_parent_idx on public.analytics_events
 ((properties->>'parent_flow_id'),created_at desc,id desc)
 where properties->>'feature_identifier'='catalog_manager'
 and properties->>'flow_step'='catalog_manager_stop' and properties ? 'parent_flow_id';
create index analytics_catalog_stop_origin_idx on public.analytics_events
 ((properties->>'workflow_id'),created_at desc,id desc)
 where properties->>'feature_identifier'='catalog_manager'
 and properties->>'flow_step'='catalog_manager_stop' and properties ? 'workflow_id';
create index analytics_catalog_stop_actor_idx on public.analytics_events
 (user_id,created_at desc,id desc)
 where properties->>'feature_identifier'='catalog_manager'
 and properties->>'flow_step'='catalog_manager_stop';
commit;
