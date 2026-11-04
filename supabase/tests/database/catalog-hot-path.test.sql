begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(4);

select has_index('private', 'catalog_image_journal', 'catalog_image_journal_evidence_id',
  'image diagnostic lookups have an index on their projected evidence key');

-- Exercise the consumer's privacy view, rather than merely matching an index definition.
-- Disabling sequential scans proves eligibility without asserting wall-clock speed or table size.
set local enable_seqscan = off;
create function pg_temp.catalog_evidence_plan() returns text language plpgsql as $$
declare line record; result text := '';
begin
  for line in execute 'explain select stage,code from public.analytics_catalog_image_journal where evidence_id=''42''' loop
    result := result || line."QUERY PLAN" || E'\n';
  end loop;
  return result;
end $$;
select ok(pg_temp.catalog_evidence_plan() like '%catalog_image_journal_evidence_id%',
  'the exact agent-readable evidence lookup can use the index');

select ok(
  not has_function_privilege('authenticated', 'public.service_catalog_image_finalize_uses_v2(uuid,uuid,boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.service_catalog_image_validate_uses_v2(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.service_catalog_image_finalize_uses_v2(uuid,uuid,boolean)', 'execute')
  and has_function_privilege('service_role', 'public.service_catalog_image_validate_uses_v2(uuid,uuid)', 'execute'),
  'native hot-path writers retain service-only authorization');

select ok(private.catalog_generation_timings_v1(
  '{"attempt":1,"steps":{"sheet_write":{"calls":1,"total_ms":8,"url":"https://private.invalid"},"unsafe":{"calls":1,"total_ms":1}}}'::jsonb
) = '{"attempt":1,"steps":{"sheet_write":{"calls":1,"total_ms":8}}}'::jsonb,
  'native write durations retain only the closed numeric projection');

select * from finish();
rollback;
