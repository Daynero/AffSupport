-- A manual catalog-manager round writes ordinary cells through the native
-- non-video writer: begin-write records the sheet marker on the attempt as
-- actual_changes._nativeNonVideoMarker, then the worker records the visible
-- change summary with service_record_catalog_update_changes, which REPLACED
-- actual_changes and dropped the marker. The sheet kept the marker while no
-- attempt remembered it, so every later round saw an unexplained marker and
-- failed with PROCESS_RESULT_UNCERTAIN before any stage (beta 2026-11-10: the
-- first manual round of TR 14_v3/v4 succeeded, every later one failed).
--
-- 1. Recording the summary keeps the attempt's internal keys (prefixed "_").
-- 2. The non-video context reports markerRecordLost when the latest verified
--    attempt of the catalog carries no marker record, so a catalog stranded by
--    the old behaviour can adopt the single marker its own sheet carries.
begin;

create or replace function public.service_record_catalog_update_changes(
  p_item uuid, p_worker text, p_changes jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare due_at timestamptz; key text;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for key in select jsonb_object_keys(p_changes) loop
    if key not in ('productIds', 'linksVaried', 'imagesRefreshed',
                   'textsRefreshed', 'productsAdded')
       or jsonb_typeof(p_changes -> key) <> 'boolean' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end loop;
  select item.round_due_at into due_at from public.team_catalog_updater_items as item
  where item.catalog_material_id = p_item and item.lease_owner = p_worker
    and item.lease_expires_at > clock_timestamp() and item.round_due_at is not null;
  if not found then return false; end if;
  update public.team_catalog_update_attempts as attempt
     set actual_changes = coalesce((
           select jsonb_object_agg(kept.key, kept.value)
           from jsonb_each(coalesce(attempt.actual_changes, '{}'::jsonb)) as kept
           where left(kept.key, 1) = '_'
         ), '{}'::jsonb) || p_changes
   where attempt.catalog_material_id = p_item and attempt.round_due_at = due_at
     and attempt.result in ('running', 'unknown');
  return found;
end;
$$;
revoke all on function public.service_record_catalog_update_changes(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.service_record_catalog_update_changes(uuid, text, jsonb)
  to service_role;

do $marker_record_lost$
declare d text;
begin
  select pg_get_functiondef('private.catalog_nonvideo_update_context(uuid,text)'::regprocedure) into d;
  if strpos(d, $find$'contextToken',encode($find$) = 0 then
    raise exception 'NONVIDEO_CONTEXT_MARKER_PATCH_MISSING';
  end if;
  d := replace(d, $find$'contextToken',encode($find$, $replace$'markerRecordLost',coalesce((select not(latest.actual_changes ? '_nativeNonVideoMarker') from public.team_catalog_update_attempts latest where latest.catalog_material_id=p_item and latest.delivery_verified_at is not null and latest.attempt_id<>a.attempt_id order by latest.started_at desc limit 1),false),'contextToken',encode($replace$);
  execute d;
end
$marker_record_lost$;

commit;
