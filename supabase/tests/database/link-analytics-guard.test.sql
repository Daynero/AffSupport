begin;
select plan(26);

-- 032: the property guard admits every key of the link lifecycle, holds each
-- closed vocabulary closed, and keeps a duration inside one year. One accepted
-- payload per new key, then the shapes a tampered client could send.

-- link_check_started: trigger, origin, browser family.
select ok(public.analytics_properties_are_safe_v2(
  '{"link_trigger":"boot","link_origin":"hosted","browser_family":"safari"}'::jsonb),
  'link_check_started properties are accepted');
select ok(public.analytics_properties_are_safe_v2(
  '{"link_trigger":"token_changed","link_origin":"local_copy","browser_family":"other"}'::jsonb),
  'a token_changed trigger is a vocabulary word, not a secret');

-- link_check_completed: outcome, reason, stage, duration.
select ok(public.analytics_properties_are_safe_v2(
  '{"outcome":"failure","link_reason":"not_running","link_stage":"probe","duration_ms":812}'::jsonb),
  'link_check_completed properties are accepted');
select ok(public.analytics_properties_are_safe_v2(
  '{"outcome":"blocked","link_reason":"blocked_by_browser","link_stage":"probe","duration_ms":0}'::jsonb),
  'a blocked check with a zero duration is accepted');

-- link_lost: transport and reason.
select ok(public.analytics_properties_are_safe_v2(
  '{"link_transport":"watchdog","link_reason":"timeout"}'::jsonb),
  'link_lost properties are accepted');

-- link_recovered: duration, mode, two booleans.
select ok(public.analytics_properties_are_safe_v2(
  '{"duration_ms":86400000,"recovery_mode":"manual","instance_changed":true,"token_changed":false}'::jsonb),
  'link_recovered properties are accepted up to a one-day break');

-- reconnect_clicked: surface.
select ok(public.analytics_properties_are_safe_v2('{"surface":"team_process_dialog"}'::jsonb),
  'reconnect_clicked surface is accepted');

-- pairing_*: method and reason.
select ok(public.analytics_properties_are_safe_v2(
  '{"pairing_method":"fragment","link_reason":"pairing_rejected"}'::jsonb),
  'pairing properties are accepted');

-- blocked_by_browser_detected: browser family and origin.
select ok(public.analytics_properties_are_safe_v2(
  '{"browser_family":"safari","link_origin":"hosted"}'::jsonb),
  'blocked_by_browser_detected properties are accepted');

-- link_inconsistency: transport, error class, stream flag.
select ok(public.analytics_properties_are_safe_v2(
  '{"link_transport":"request","error_code":"unauthorized","link_stream_open":true}'::jsonb),
  'link_inconsistency properties are accepted');

-- What the guard was already accepting still passes.
select ok(public.analytics_properties_are_safe_v2(
  '{"tool_identifier":"compressor","video_count":3,"mode":"optimal","retryable":false,"duration_ms":5000}'::jsonb),
  'pre-032 properties are still accepted');

-- Every vocabulary stays closed.
select ok(not public.analytics_properties_are_safe_v2('{"link_trigger":"wake"}'::jsonb),
  'an unknown link_trigger is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"link_origin":"staging"}'::jsonb),
  'an unknown link_origin is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"browser_family":"opera"}'::jsonb),
  'an unknown browser_family is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"link_reason":"cosmic_rays"}'::jsonb),
  'an unknown link_reason is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"link_stage":"dns"}'::jsonb),
  'an unknown link_stage is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"link_transport":"carrier_pigeon"}'::jsonb),
  'an unknown link_transport is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"recovery_mode":"prayer"}'::jsonb),
  'an unknown recovery_mode is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"surface":"settings"}'::jsonb),
  'an unknown surface is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"pairing_method":"qr"}'::jsonb),
  'an unknown pairing_method is rejected');

-- Booleans are booleans.
select ok(not public.analytics_properties_are_safe_v2('{"instance_changed":"true"}'::jsonb),
  'a string instance_changed is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"token_changed":1}'::jsonb),
  'a numeric token_changed is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"link_stream_open":"open"}'::jsonb),
  'a string link_stream_open is rejected');

-- A duration is a number inside one year (the shared sanitizer's bound).
select ok(not public.analytics_properties_are_safe_v2('{"duration_ms":31536000001}'::jsonb),
  'a duration above one year is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"duration_ms":-1}'::jsonb),
  'a negative duration is rejected');
select ok(not public.analytics_properties_are_safe_v2('{"duration_ms":"812"}'::jsonb),
  'a string duration is rejected');

select * from finish();
rollback;
