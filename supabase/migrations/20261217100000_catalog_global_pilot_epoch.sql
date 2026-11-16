-- 052 pilot on next (2026-11-16): a pilot space reported usable=true with policyEpoch 0,
-- because the policy epoch only advances at T0. Every client and edge guard requires a
-- usable pool to carry an epoch of at least 1 (allocation requests, issued image rows,
-- readiness), so the pilot answered INVALID_RESPONSE and drew nothing.
--
-- A pilot space now works in the epoch T0 will open: activation sets epoch = epoch + 1,
-- so before T0 a pilot space uses epoch + 1 and after T0 everyone uses the same number.
-- Catalogs made in the pilot stay valid across T0; nothing else changes for other spaces.
begin;

create function private.catalog_global_epoch(p_team uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select case when c.activated_at is null and private.catalog_global_is_active(p_team)
              then c.epoch + 1 else c.epoch end
    from private.catalog_global_policy c where c.singleton;
$$;
revoke all on function private.catalog_global_epoch(uuid) from public, anon, authenticated, service_role;

do $epoch$
declare
  d text;
  sig text;
begin
  foreach sig in array array[
    'public.service_catalog_global_allocate(uuid,uuid,uuid,uuid,integer,bigint,text,jsonb)',
    'public.service_catalog_global_readiness(uuid,uuid)',
    'public.service_catalog_global_validate_rows(uuid,jsonb)'
  ] loop
    select pg_get_functiondef(sig::regprocedure) into d;
    if strpos(d, 'cfg.epoch') = 0 then raise exception 'CATALOG_GLOBAL_PILOT_EPOCH_SEAM_MISSING %', sig; end if;
    execute replace(d, 'cfg.epoch', 'private.catalog_global_epoch(p_team)');
  end loop;

  select pg_get_functiondef(
    'public.service_draw_product_catalog_images_v3(uuid,integer,uuid,text,uuid,jsonb)'::regprocedure) into d;
  if strpos(d, 'select p.epoch into epoch from private.catalog_global_policy p where singleton;') = 0 then
    raise exception 'CATALOG_GLOBAL_PILOT_EPOCH_SEAM_MISSING draw_v3';
  end if;
  execute replace(d, 'select p.epoch into epoch from private.catalog_global_policy p where singleton;',
    'epoch := private.catalog_global_epoch(p_team);');

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('public', 'private') and p.prosrc like '%cfg.epoch%'
                and p.proargnames @> array['p_team']) then
    raise exception 'CATALOG_GLOBAL_PILOT_EPOCH_READER_LEFT';
  end if;
end $epoch$;

commit;
