-- 1.4.3: catalogs whose Drive connection is detached, root_missing or
-- needs_reauth could never finish a round. private.claim_catalog_updater_items
-- leased them every minute, the wrapper service_claim_catalog_updater_items
-- dropped them (connected/unavailable only), so the round stayed open forever:
-- the manager kept saying "Оновлюємо …", item attempts climbed into the
-- hundreds, and Stop raised WRONG_STATE against the worker's claim lease.
-- A dispatched publication job on such a catalog was likewise re-claimed every
-- minute and answered SOURCE_CHANGED.
--
-- * A round on an unusable connection ends at once as failed with a code the
--   manager already explains (NEEDS_REAUTH / ROOT_MISSING / DRIVE_UNAVAILABLE),
--   and such items are never leased. 'unavailable' is a passing outage and
--   keeps retrying as before.
-- * Stop may end a round held only by a worker's claim lease: both write starts
--   (begin_catalog_update_write / begin_catalog_nonvideo_update_write) require
--   that live lease and an open round, so a cancelled round can no longer be
--   written, and nothing before the write start changes the sheet.
-- * Publication jobs and preparations of a catalog on an unusable connection
--   are not claimed until the connection is usable again.
begin;

create function private.catalog_connection_usable(p_catalog uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from public.team_materials sheet
  join public.team_drive_connections connection
    on connection.id=sheet.connection_id and connection.team_id=sheet.team_id
  where sheet.id=p_catalog and connection.state in('connected','unavailable'))
$$;
revoke all on function private.catalog_connection_usable(uuid) from public,anon,authenticated,service_role;

create function private.close_unreachable_catalog_rounds() returns integer
language plpgsql security definer set search_path='' as $$
declare closed integer:=0; stuck record; code text;
begin
 for stuck in
  select item.catalog_material_id, item.team_id, item.round_due_at, connection.state
  from public.team_catalog_updater_items item
  join public.team_materials sheet on sheet.id=item.catalog_material_id and sheet.team_id=item.team_id
  join public.team_drive_connections connection
    on connection.id=sheet.connection_id and connection.team_id=sheet.team_id
  where item.round_due_at is not null
    and item.tariff_pause_id is null
    and not item.reconciliation_required
    and connection.state not in('connected','unavailable')
    and not exists(select 1 from private.catalog_update_reconciliations pending
      where pending.catalog_material_id=item.catalog_material_id)
    and (item.lease_owner is null or item.lease_expires_at is null
      or item.lease_expires_at<=clock_timestamp())
  for update of item skip locked
 loop
  code:=case stuck.state when 'root_missing' then 'ROOT_MISSING'
                         when 'pending' then 'DRIVE_UNAVAILABLE'
                         else 'NEEDS_REAUTH' end;
  update public.team_catalog_update_attempts
     set result='failed', failure_code=code, ended_at=clock_timestamp()
   where catalog_material_id=stuck.catalog_material_id and round_due_at=stuck.round_due_at
     and result in('running','unknown');
  update public.team_product_catalogs
     set last_update_error=code, last_update_error_at=clock_timestamp()
   where material_id=stuck.catalog_material_id;
  update public.team_catalog_updater_items
     set round_due_at=null, attempts=0, lease_owner=null, lease_expires_at=null,
         next_attempt_at=clock_timestamp()
   where catalog_material_id=stuck.catalog_material_id;
  insert into public.team_catalog_events(team_id,material_id,event_kind)
  values(stuck.team_id,stuck.catalog_material_id,'upserted');
  perform private.sync_catalog_updater(stuck.team_id);
  closed:=closed+1;
 end loop;
 return closed;
end $$;
revoke all on function private.close_unreachable_catalog_rounds() from public,anon,authenticated,service_role;

do $claim$
declare d text;
begin
 select pg_get_functiondef('private.claim_catalog_updater_items(text,integer,integer)'::regprocedure) into d;
 if strpos(d,'if not pg_catalog.pg_try_advisory_xact_lock(72301500) then return; end if;')=0
    or strpos(d,'and not item.reconciliation_required')=0 then
  raise exception 'CATALOG_CLAIM_UNREACHABLE_PATCH_MISSING';
 end if;
 d:=replace(d,'if not pg_catalog.pg_try_advisory_xact_lock(72301500) then return; end if;',
  'if not pg_catalog.pg_try_advisory_xact_lock(72301500) then return; end if;
  perform private.close_unreachable_catalog_rounds();');
 d:=replace(d,'and not item.reconciliation_required',
  'and not item.reconciliation_required
      and private.catalog_connection_usable(item.catalog_material_id)');
 execute d;
end $claim$;

do $stop$
declare d text;
begin
 select pg_get_functiondef('public.cancel_team_catalog_update(uuid,uuid)'::regprocedure) into d;
 if strpos(d,'if item.lease_owner is not null and')=0 then
  raise exception 'CATALOG_STOP_WORKER_LEASE_PATCH_MISSING';
 end if;
 d:=replace(d,'if item.lease_owner is not null and',
  'if item.lease_owner is not null and item.lease_owner not like ''catalog-updater:%'' and');
 execute d;
end $stop$;

do $publication$
declare d text;
begin
 select pg_get_functiondef('public.service_claim_catalog_publication_jobs(uuid,integer)'::regprocedure) into d;
 if strpos(d,'and q.next_attempt_at<=clock_timestamp()')=0 then
  raise exception 'CATALOG_PUBLICATION_CLAIM_PATCH_MISSING';
 end if;
 d:=replace(d,'and q.next_attempt_at<=clock_timestamp()',
  'and q.next_attempt_at<=clock_timestamp() and private.catalog_connection_usable(q.catalog_material_id)');
 execute d;
 select pg_get_functiondef('public.service_claim_catalog_publication_preparations(uuid,integer)'::regprocedure) into d;
 if strpos(d,'where j.dispatched_at is null and j.writer_fence is null')=0 then
  raise exception 'CATALOG_PREPARATION_CLAIM_PATCH_MISSING';
 end if;
 d:=replace(d,'where j.dispatched_at is null and j.writer_fence is null',
  'where j.dispatched_at is null and j.writer_fence is null and private.catalog_connection_usable(j.catalog_material_id)');
 execute d;
end $publication$;
commit;
