begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(17);
select ok(public.analytics_properties_are_safe_v2('{"installer_target":"macos-x64"}'::jsonb), 'installer intent is independent of native identity');
select isnt(public.analytics_properties_are_safe_v2('{"installer_target":"/Users/private"}'::jsonb), true, 'installer target refuses raw paths');
select ok(public.analytics_properties_are_safe_v2('{"agent_architecture":"x64","package_target":"macos-x64"}'::jsonb), 'Intel native identity accepted');
select ok(public.analytics_properties_are_safe_v2('{"agent_architecture":"arm64","package_target":"macos-arm64"}'::jsonb), 'ARM native identity accepted');
select ok(public.analytics_properties_are_safe_v2('{"agent_architecture":"x64","package_target":"windows-x64"}'::jsonb), 'Windows x64 stays separate');
select ok(public.analytics_properties_are_safe_v2('{"agent_architecture":"unknown","package_target":"unknown"}'::jsonb), 'unknown identity explicit');
select isnt(public.analytics_properties_are_safe_v2('{"agent_architecture":"/Users/private"}'::jsonb), true, 'raw paths rejected');
select isnt(public.analytics_properties_are_safe_v2('{"package_target":"future-target"}'::jsonb), true, 'unknown target vocabulary rejected');
select ok(public.analytics_properties_are_safe_v2('{"native_startup_id":"00000000-0000-4000-8000-000000000001"}'::jsonb), 'native startup UUID accepted');
select isnt(public.analytics_properties_are_safe_v2('{"native_startup_id":"raw-user-content"}'::jsonb), true, 'native startup free text rejected');
select isnt(public.analytics_properties_are_safe_v2('{"native_startup_id":"/Users/private/secret"}'::jsonb), true, 'native startup path rejected');
insert into auth.users (id, email, raw_user_meta_data)
values ('f0490000-0000-4000-8000-000000000001', 'runtime-049@example.test', '{}'::jsonb);
set local role authenticated;
set local request.jwt.claim.sub = 'f0490000-0000-4000-8000-000000000001';
select results_eq(
  $$select accepted from public.ingest_analytics_events('[{
    "event_id":"f0490000-0000-4000-8000-000000000002",
    "event_name":"compression_completed","event_version":2,
    "agent_platform":"macos","platform":"macos",
    "agent_instance_id":"f0490000-0000-4000-8000-000000000003",
    "properties":{"agent_architecture":"x64","package_target":"macos-x64","native_startup_id":"f0490000-0000-4000-8000-000000000004"}
  }]'::jsonb)$$, array[true], 'authenticated ingestion accepts native context');
select results_eq(
  $$select accepted from public.ingest_analytics_events('[{
    "event_id":"f0490000-0000-4000-8000-000000000005",
    "event_name":"compression_completed","event_version":2,
    "properties":{"native_startup_id":"raw-user-content"}
  }]'::jsonb)$$, array[false], 'ingestion refuses private/free-form startup identifiers');
select results_eq(
  $$select accepted from public.ingest_analytics_events('[{
    "event_id":"f0490000-0000-4000-8000-000000000006",
    "event_name":"install_download_clicked","event_version":2,
    "properties":{"installer_target":"macos-x64"}
  }]'::jsonb)$$, array[true], 'ingestion accepts requested installer without native claims');
reset role;
select results_eq(
  $$select properties->>'installer_target', properties ? 'package_target', agent_instance_id is null
    from public.analytics_events where event_id='f0490000-0000-4000-8000-000000000006'$$,
  $$values ('macos-x64'::text,false,true)$$,
  'a stored download request does not become an installed native identity');
select results_eq(
  $$select agent_platform, properties->>'agent_architecture', properties->>'package_target', properties->>'native_startup_id'
    from public.analytics_events where event_id='f0490000-0000-4000-8000-000000000002'$$,
  $$values ('macos'::text,'x64'::text,'macos-x64'::text,'f0490000-0000-4000-8000-000000000004'::text)$$,
  'the actual RPC preserves native context in stored rows');
select is((select count(*) from public.analytics_events where event_id='f0490000-0000-4000-8000-000000000005'),0::bigint,'refused private metadata is never stored');
select * from finish();
rollback;
