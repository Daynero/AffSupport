-- Validate the chosen timezone without scanning every tzdata entry per schedule check.
begin;
create or replace function private.valid_catalog_schedule(p_schedule jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
declare zone text;
begin
  if p_schedule is null then return true; end if;
  if jsonb_typeof(p_schedule) <> 'object' then return false; end if;
  if not (p_schedule ?& array['timeZone','weekday','time'])
     or (select count(*) from jsonb_object_keys(p_schedule)) <> 3
     or jsonb_typeof(p_schedule -> 'timeZone') <> 'string'
     or jsonb_typeof(p_schedule -> 'weekday') <> 'number'
     or jsonb_typeof(p_schedule -> 'time') <> 'string'
     or (p_schedule ->> 'weekday') !~ '^[1-7]$'
     or (p_schedule ->> 'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return false; end if;
  zone := p_schedule ->> 'timeZone';
  -- Resolve only the requested IANA name. pg_timezone_names materializes the
  -- entire tzdata catalog on every call, including constraint/scheduler reads.
  -- Exclude abbreviations, offsets and POSIX rules before invoking the resolver.
  if length(zone)>128 or zone !~ '^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)+)$' then
    return false;
  end if;
  begin
    perform pg_catalog.timezone(zone,timestamp with time zone '2026-01-01 00:00:00+00');
  exception when invalid_parameter_value then
    return false;
  end;
  return true;
end;
$$;
revoke all on function private.valid_catalog_schedule(jsonb) from public,anon,authenticated;
commit;
