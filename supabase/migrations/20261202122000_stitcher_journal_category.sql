-- Add the bounded stitcher recovery category to the agent journal ingest fence.
create or replace function public.ingest_agent_journal(
  p_installation_id uuid,
  p_agent_instance_id uuid,
  p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_item jsonb;
  v_seq bigint;
  v_number numeric;
  v_recorded_at timestamptz;
  v_category text;
  v_code text;
  v_props jsonb;
  v_reason text;
  v_prop record;
  v_text text;
  v_inserted integer;
  v_accepted integer := 0;
  v_duplicates integer := 0;
  v_rejected jsonb := '[]'::jsonb;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_agent_instance_id is null then
    raise exception 'An agent instance is required' using errcode = '22023';
  end if;
  if p_records is null or pg_catalog.jsonb_typeof(p_records) <> 'array'
    or pg_catalog.jsonb_array_length(p_records) > 200 then
    raise exception 'Expected at most 200 records' using errcode = '22023';
  end if;

  for v_item in select value from pg_catalog.jsonb_array_elements(p_records)
  loop
    v_reason := null;
    v_seq := null;
    v_recorded_at := null;

    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      v_reason := 'invalid_record';
    end if;

    -- seq: a positive integer that fits a bigint. Nested so no cast ever
    -- sees a value whose type was not checked first.
    if v_reason is null then
      v_reason := 'invalid_seq';
      if pg_catalog.jsonb_typeof(v_item -> 'seq') = 'number' then
        v_number := (v_item ->> 'seq')::numeric;
        if v_number > 0 and v_number = pg_catalog.trunc(v_number)
          and v_number <= 9223372036854775807 then
          v_seq := v_number::bigint;
          v_reason := null;
        end if;
      end if;
    end if;

    -- at: epoch milliseconds, and not more than one day ahead of this clock.
    if v_reason is null then
      v_reason := 'invalid_time';
      if pg_catalog.jsonb_typeof(v_item -> 'at') = 'number' then
        v_number := (v_item ->> 'at')::numeric;
        if v_number > 0 and v_number < 253402300800000 then
          v_recorded_at := pg_catalog.to_timestamp((v_number / 1000)::double precision);
          v_reason := case when v_recorded_at > pg_catalog.now() + interval '1 day'
            then 'future_time' else null end;
        end if;
      end if;
    end if;

    -- category: DIAGNOSTIC_CATEGORIES, verbatim.
    if v_reason is null then
      v_category := case when pg_catalog.jsonb_typeof(v_item -> 'category') = 'string'
        then v_item ->> 'category' else null end;
      if v_category is null or v_category not in (
        'boot',
        'shutdown',
        'stream',
        'auth',
        'entitlement',
        'spawn',
        'picker',
        'drop',
        'update',
        'power',
        'stitcher',
        'team'
      ) then
        v_reason := 'invalid_category';
      end if;
    end if;

    if v_reason is null then
      v_code := case when pg_catalog.jsonb_typeof(v_item -> 'code') = 'string'
        then v_item ->> 'code' else null end;
      if v_code is null or v_code !~ '^[a-z][a-z0-9_]{1,63}$' then
        v_reason := 'invalid_code';
      end if;
    end if;

    -- props: an object of at most 16 safe keys; every value a number, a
    -- boolean, or a short vocabulary word that cannot be a path, a URL, an
    -- address or a credential.
    if v_reason is null then
      v_props := coalesce(v_item -> 'props', '{}'::jsonb);
      if pg_catalog.jsonb_typeof(v_props) = 'null' then
        v_props := '{}'::jsonb;
      end if;
      if pg_catalog.jsonb_typeof(v_props) <> 'object' then
        v_reason := 'invalid_props';
      elsif (select count(*) from pg_catalog.jsonb_object_keys(v_props)) > 16 then
        v_reason := 'too_many_props';
      else
        for v_prop in select key, value from pg_catalog.jsonb_each(v_props)
        loop
          if v_prop.key !~ '^[a-zA-Z][a-zA-Z0-9_]{0,31}$' then
            v_reason := 'invalid_prop_key';
          elsif pg_catalog.jsonb_typeof(v_prop.value) in ('number', 'boolean') then
            null;
          elsif pg_catalog.jsonb_typeof(v_prop.value) = 'string' then
            v_text := pg_catalog.lower(v_prop.value #>> '{}');
            if pg_catalog.length(v_text) < 1 or pg_catalog.length(v_text) > 64 then
              v_reason := 'invalid_prop_value';
            elsif pg_catalog.strpos(v_text, '/') > 0
              or pg_catalog.strpos(v_text, '\') > 0
              or pg_catalog.strpos(v_text, '://') > 0
              or pg_catalog.strpos(v_text, 'token') > 0
              or pg_catalog.strpos(v_text, 'bearer') > 0
              or pg_catalog.strpos(v_text, '@') > 0 then
              v_reason := 'unsafe_prop_value';
            end if;
          else
            v_reason := 'invalid_prop_value';
          end if;
          exit when v_reason is not null;
        end loop;
      end if;
    end if;

    if v_reason is not null then
      v_rejected := v_rejected || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('seq', v_seq, 'reason', v_reason));
      continue;
    end if;

    insert into public.agent_journal_records (
      user_id, installation_id, agent_instance_id, seq, recorded_at, category, code, props
    ) values (
      v_user, p_installation_id, p_agent_instance_id, v_seq, v_recorded_at, v_category, v_code,
      v_props
    )
    on conflict (agent_instance_id, seq) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      v_accepted := v_accepted + 1;
    else
      v_duplicates := v_duplicates + 1;
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'accepted', v_accepted,
    'duplicates', v_duplicates,
    'rejected', v_rejected);
end;
$$;
