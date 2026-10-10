begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(42);

-- 031: the property guard admits every key the client sends, one accepted
-- payload per key added by 20261117100000_analytics_guard_contract.sql, then the
-- shapes a tampered or outdated client could send. The exhaustive key-by-key
-- comparison with the client allowlist lives in
-- tests/analytics-guard-contract.test.ts (PGlite); this file is the database's
-- own regression.

-- power_limit_changed
select ok(public.analytics_properties_are_safe_v2('{"limit_percent":20}'::jsonb),
  'limit_percent at its lower bound is accepted');
-- team_storage_connected
select ok(public.analytics_properties_are_safe_v2('{"selection_count":0}'::jsonb),
  'selection_count is accepted');
-- team_index_completed
select ok(public.analytics_properties_are_safe_v2('{"folder_count":100000}'::jsonb),
  'folder_count at its upper bound is accepted');
-- team_previews_ready
select ok(public.analytics_properties_are_safe_v2('{"ready_count":42}'::jsonb),
  'ready_count is accepted');
select ok(public.analytics_properties_are_safe_v2('{"unavailable_count":3}'::jsonb),
  'unavailable_count is accepted');
-- team_storage_attention
select ok(public.analytics_properties_are_safe_v2('{"attention_reason":"needs_reauth"}'::jsonb),
  'attention_reason is accepted');
-- team_landing_gallery_view / team_landing_open
select ok(public.analytics_properties_are_safe_v2('{"item_count":300}'::jsonb),
  'item_count is accepted');
select ok(public.analytics_properties_are_safe_v2('{"tile_state":"needs_agent"}'::jsonb),
  'tile_state is accepted');
select ok(public.analytics_properties_are_safe_v2('{"had_agent":true}'::jsonb),
  'had_agent is accepted');
-- team_landing_render
select ok(public.analytics_properties_are_safe_v2('{"reason":"protected"}'::jsonb),
  'reason is accepted');
-- team_library_* / team_task_completed
select ok(public.analytics_properties_are_safe_v2('{"contribution_category":"local_processing"}'::jsonb),
  'contribution_category is accepted');
select ok(public.analytics_properties_are_safe_v2('{"contribution_action":"transcription"}'::jsonb),
  'contribution_action is accepted');
-- A client that still repeats the routing id in properties is not refused.
select ok(public.analytics_properties_are_safe_v2('{"run_id":"77777777-7777-4777-8777-777777777777"}'::jsonb),
  'run_id in properties is accepted');
-- analytics_delivery_report
select ok(public.analytics_properties_are_safe_v2('{"rejected_count":1}'::jsonb),
  'rejected_count is accepted');
select ok(public.analytics_properties_are_safe_v2('{"evicted_count":0}'::jsonb),
  'evicted_count is accepted');
select ok(public.analytics_properties_are_safe_v2('{"expired_count":100000}'::jsonb),
  'expired_count at its upper bound is accepted');
select ok(public.analytics_properties_are_safe_v2(
  '{"rejected_events":"team_landing_render,power_limit_changed"}'::jsonb),
  'a comma-joined list of event names is accepted');
select ok(public.analytics_properties_are_safe_v2('{"evicted_events":"home_viewed"}'::jsonb),
  'a single-name list is accepted');
select ok(public.analytics_properties_are_safe_v2('{"report_window_ms":86400000}'::jsonb),
  'report_window_ms of one day is accepted');

-- Whole events of the 031 client.
select ok(public.analytics_properties_are_safe_v2(
  '{"tool_identifier":"compressor","outcome":"success","duration_ms":120}'::jsonb),
  'tool_ready success properties are accepted');
select ok(public.analytics_properties_are_safe_v2(
  '{"tool_identifier":"transcription","outcome":"failure","duration_ms":5000,"error_stage":"initial_read","error_code":"CONNECTION_FAILED"}'::jsonb),
  'tool_ready failure properties are accepted');
select ok(public.analytics_properties_are_safe_v2(
  '{"attempt_id":"abc123","outcome":"success","duration_ms":1200}'::jsonb),
  'team_landing_render with the renamed outcome is accepted');
select ok(public.analytics_properties_are_safe_v2(
  '{"tool_identifier":"compressor","error_stage":"encode","error_code":"FFMPEG_EXIT","error_fingerprint":"compressor:encode:FFMPEG_EXIT","retryable":false}'::jsonb),
  'error_occurred of the compressor is accepted');
select ok(public.analytics_properties_are_safe_v2('{"error_stage":"stitch"}'::jsonb),
  'the stitcher run stage is accepted');
-- What the guard was already accepting still passes.
select ok(public.analytics_properties_are_safe_v2(
  '{"tool_identifier":"compressor","video_count":3,"mode":"optimal","retryable":false,"duration_ms":5000}'::jsonb),
  'pre-031 properties are still accepted');

-- Every vocabulary stays closed.
select ok(not public.analytics_properties_are_safe_v2('{"attention_reason":"__bad__"}'::jsonb),
  'an unknown attention_reason is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"tile_state":"stale"}'::jsonb),
  'an unknown tile_state is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"reason":"other"}'::jsonb),
  'an unknown reason is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"contribution_category":"__bad__"}'::jsonb),
  'an unknown contribution_category is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"contribution_action":"__bad__"}'::jsonb),
  'an unknown contribution_action is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"error_stage":"__bad__"}'::jsonb),
  'an error_stage outside the per-tool vocabulary is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"tool_identifier":"sandbox"}'::jsonb),
  'an unknown tool_identifier is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"outcome":"ready"}'::jsonb),
  'the old landing outcome word is still refused');

-- Booleans are booleans; numbers are numbers inside the client range.
select ok(not public.analytics_properties_are_safe_v2('{"had_agent":"true"}'::jsonb),
  'a string had_agent is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"limit_percent":19}'::jsonb),
  'a limit below 20 percent is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"limit_percent":101}'::jsonb),
  'a limit above 100 percent is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"selection_count":100001}'::jsonb),
  'a selection_count above the bound is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"video_count":"3"}'::jsonb),
  'a string video_count is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"report_window_ms":86400001}'::jsonb),
  'a report window above one day is rejected');

-- The event-name lists hold names, at most ten of them.
select ok(not public.analytics_properties_are_safe_v2('{"rejected_events":"home_viewed,/etc"}'::jsonb),
  'a path inside an event list is rejected');
select ok(not public.analytics_properties_are_safe_v2(
  '{"evicted_events":"e1,e2,e3,e4,e5,e6,e7,e8,e9,e10,e11"}'::jsonb),
  'an event list of eleven names is rejected');

-- The allowlist itself stays closed.
select ok(not public.analytics_properties_are_safe_v2('{"unknown_key":1}'::jsonb),
  'an unknown key is rejected');

select * from finish();
rollback;
