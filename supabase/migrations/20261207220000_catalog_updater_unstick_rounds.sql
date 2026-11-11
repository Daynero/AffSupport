-- Catalog manager rounds that could never end (production, 2026-11-10/11).
--
-- 1. Stop on a video variant round always raised WRONG_STATE. Both variant
--    entry points (service_accept_catalog_updater_variants, the manager's
--    "video variations", and service_adopt_catalog_variant_round, a Run with
--    re-stitch) hold the item with lease 'catalog-variants:<request>' until
--    'infinity'; cancel_team_catalog_update refused any live lease. The round's
--    own cancel path (service_cancel_catalog_updater_variants) existed but the
--    manager's Stop never reached it. Stop now ends a variant round through the
--    same steps; an ordinary worker's finite lease is still respected.
-- 2. A variant round whose child operation ended (succeeded with a lost
--    confirmation, failed, or abandoned) waited for an agent forever. The
--    worker's sweep now asks the variant resolver from 20261207199000 for
--    manager rounds too; a child that can no longer succeed ends the round as
--    failed instead of leaving it running.
-- 3. Running attempts nothing can pick up (their item no longer owns the
--    round, or the round has sat claimable and unclaimed for six hours) are
--    closed once, idempotently, so the history and the manager stop showing
--    them as in progress.
-- 4. A catalog quarantined for review with nothing to reconcile (no
--    reconciliation row, nothing running) is released.
begin;

create function private.cancel_catalog_updater_variant_round(p_team uuid,p_catalog uuid,p_request uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;
begin
 select * into r from private.catalog_updater_variant_requests
  where request_id=p_request and team_id=p_team and catalog_material_id=p_catalog for update;
 if r.request_id is null then return false;end if;
 perform private.hold_catalog_updater_variant_publication(r);
 update private.catalog_updater_variant_requests set canceled_at=coalesce(canceled_at,clock_timestamp()) where request_id=p_request;
 update public.team_catalog_update_attempts set result='cancelled',ended_at=coalesce(ended_at,clock_timestamp())
  where attempt_id=r.attempt_id and result='running';
 update private.catalog_video_sets set state=case when exists(select 1 from private.catalog_video_variants
   where video_set_id=r.set_id and state in('working','unknown')) then 'cancel_requested' else 'canceled' end,revision=revision+1
  where id=r.set_id and state not in('cancel_requested','canceled');
 update public.team_catalog_updater_items set round_due_at=null,attempts=0,next_attempt_at=clock_timestamp(),lease_owner=null,lease_expires_at=null
  where catalog_material_id=p_catalog and team_id=p_team and lease_owner='catalog-variants:'||p_request::text;
 insert into public.team_catalog_events(team_id,material_id,event_kind) values(p_team,p_catalog,'sync_state');
 return true;
end $$;
revoke all on function private.cancel_catalog_updater_variant_round(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.cancel_team_catalog_update(p_team uuid, p_catalog uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare item public.team_catalog_updater_items%rowtype;variant_request uuid;
begin
  if auth.uid() is null or not private.can(p_team,'process',auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  -- All interactive Run/Stop paths take the updater before an item.
  perform 1 from public.team_catalog_updaters where team_id=p_team for update;
  select * into item from public.team_catalog_updater_items
    where team_id=p_team and catalog_material_id=p_catalog for update;
  if coalesce(item.reconciliation_required,false) or exists(
    select 1 from private.catalog_update_reconciliations pending
    join public.team_product_catalogs catalog on catalog.material_id=pending.catalog_material_id
    where pending.catalog_material_id=p_catalog and catalog.team_id=p_team
  ) then
    raise exception 'CATALOG_UPDATE_RECONCILIATION_REQUIRED' using errcode='55000';
  end if;
  if item.catalog_material_id is null or item.round_due_at is null then return false; end if;
  -- A video variant round holds the item until 'infinity' while its videos
  -- are made; Stop ends it through the round's own cancel steps.
  if item.lease_owner ~ '^catalog-variants:[0-9a-f-]{36}$' then
    variant_request:=substr(item.lease_owner,18)::uuid;
    if private.cancel_catalog_updater_variant_round(p_team,p_catalog,variant_request) then
      perform private.sync_catalog_updater(p_team);
      return true;
    end if;
  end if;
  if item.lease_owner is not null and
     (item.lease_expires_at is null or item.lease_expires_at>clock_timestamp()) then
    raise exception 'WRONG_STATE' using errcode='55000';
  end if;
  update public.team_catalog_updater_items
    set round_due_at=null,attempts=0,lease_owner=null,lease_expires_at=null,
        next_attempt_at=clock_timestamp()
    where team_id=p_team and catalog_material_id=p_catalog;
  perform private.sync_catalog_updater(p_team);
  return true;
end $$;

-- Worker sweep: bounded, idempotent, service role only.
create function public.service_sweep_catalog_updater_rounds(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r record;n integer;answer jsonb;variant_sets integer:=0;orphans integer:=0;released integer:=0;code text;changed integer;
begin
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'INVALID_INPUT' using errcode='22023';end if;

 -- (2) Variant rounds whose children ended: resolve each stuck child.
 for r in
  select req.request_id,req.team_id,req.catalog_material_id,req.set_id,req.attempt_id
  from private.catalog_updater_variant_requests req
  join public.team_catalog_update_attempts a on a.attempt_id=req.attempt_id and a.team_id=req.team_id and a.result='running'
  join private.catalog_video_sets s on s.id=req.set_id and s.team_id=req.team_id and s.state in('accepted','preparing','unknown')
  where req.canceled_at is null
    and exists(select 1 from private.catalog_video_variants v where v.video_set_id=req.set_id and v.state in('working','unknown'))
  order by req.created_at limit p_limit
 loop
  code:=null;
  for n in select video_variant_index from private.catalog_video_variants where video_set_id=r.set_id and state in('working','unknown') order by video_variant_index loop
   answer:=private.retry_failed_catalog_video_variant(r.set_id,n);
   if answer->>'kind'='terminal' then code:=coalesce(code,answer->>'code');end if;
  end loop;
  variant_sets:=variant_sets+1;
  if code is not null then
   -- A child that can no longer succeed: the round ends, the catalog is free.
   -- A publication already dispatched for this round keeps it open (the
   -- hold raises); the next pass tries again.
   begin
    perform private.cancel_catalog_updater_variant_round(r.team_id,r.catalog_material_id,r.request_id);
    update public.team_catalog_update_attempts set result='failed',failure_code=code,ended_at=coalesce(ended_at,clock_timestamp())
     where attempt_id=r.attempt_id and result in('running','cancelled');
   exception when others then null;
   end;
  end if;
  insert into public.team_catalog_events(team_id,material_id,event_kind) values(r.team_id,r.catalog_material_id,'sync_state');
 end loop;

 -- (3a) Attempts whose round the item no longer owns can never progress.
 with lost as (
  select a.attempt_id from public.team_catalog_update_attempts a
  where a.result='running' and a.started_at<clock_timestamp()-interval '6 hours'
    and not exists(select 1 from public.team_catalog_updater_items i
      where i.catalog_material_id=a.catalog_material_id and i.team_id=a.team_id and i.round_due_at=a.round_due_at)
    and not exists(select 1 from private.catalog_updater_variant_requests req where req.attempt_id=a.attempt_id and req.canceled_at is null)
  order by a.started_at limit p_limit for update of a skip locked
 )
 update public.team_catalog_update_attempts a set result='cancelled',ended_at=clock_timestamp()
  from lost where a.attempt_id=lost.attempt_id;
 get diagnostics changed=row_count;orphans:=orphans+changed;

 -- (3b) A round the item owns but nobody has claimed for six hours.
 with idle as (
  select i.catalog_material_id,i.team_id,i.round_due_at from public.team_catalog_updater_items i
  where i.round_due_at is not null and not i.reconciliation_required
    and i.tariff_pause_id is null and i.next_attempt_at<clock_timestamp()-interval '6 hours'
    and (i.lease_owner is null or (i.lease_expires_at is not null and i.lease_expires_at<=clock_timestamp()))
    and exists(select 1 from public.team_catalog_update_attempts a where a.catalog_material_id=i.catalog_material_id and a.team_id=i.team_id
      and a.round_due_at=i.round_due_at and a.result='running' and coalesce(jsonb_array_length(a.stage_history),0)=0)
    and not exists(select 1 from private.catalog_updater_variant_requests req
      join public.team_catalog_update_attempts a on a.attempt_id=req.attempt_id
      where a.catalog_material_id=i.catalog_material_id and a.round_due_at=i.round_due_at and req.canceled_at is null)
    and not exists(select 1 from private.catalog_update_reconciliations rec where rec.catalog_material_id=i.catalog_material_id)
  order by i.next_attempt_at limit p_limit for update of i skip locked
 ), closed as (
  update public.team_catalog_update_attempts a set result='failed',failure_code='PROCESS_FAILED',ended_at=clock_timestamp()
  from idle where a.catalog_material_id=idle.catalog_material_id and a.team_id=idle.team_id and a.round_due_at=idle.round_due_at and a.result='running'
  returning a.catalog_material_id
 )
 update public.team_catalog_updater_items i set round_due_at=null,attempts=0,lease_owner=null,lease_expires_at=null,next_attempt_at=clock_timestamp()
  from idle where i.catalog_material_id=idle.catalog_material_id and i.team_id=idle.team_id and i.round_due_at=idle.round_due_at;
 get diagnostics changed=row_count;orphans:=orphans+changed;

 -- (4) Quarantined for review with nothing to reconcile and nothing running.
 with stranded as (
  select i.catalog_material_id,i.team_id from public.team_catalog_updater_items i
  where i.reconciliation_required
    and (i.lease_owner is null or (i.lease_expires_at is not null and i.lease_expires_at<=clock_timestamp()))
    and not exists(select 1 from private.catalog_update_reconciliations rec where rec.catalog_material_id=i.catalog_material_id)
    and not exists(select 1 from public.team_catalog_update_attempts a where a.catalog_material_id=i.catalog_material_id and a.team_id=i.team_id and a.result in('running','unknown'))
  limit p_limit for update of i skip locked
 ), freed as (
  update public.team_catalog_updater_items i set reconciliation_required=false,round_due_at=null,attempts=0,lease_owner=null,lease_expires_at=null,next_attempt_at=clock_timestamp()
  from stranded where i.catalog_material_id=stranded.catalog_material_id and i.team_id=stranded.team_id
  returning i.catalog_material_id,i.team_id
 ), cleared as (
  update public.team_product_catalogs c set last_update_error=null,last_update_error_at=null
  from freed where c.material_id=freed.catalog_material_id and c.last_update_error='CATALOG_ATTEMPT_STATE_INCONSISTENT'
  returning c.material_id
 )
 select count(*) into released from freed;

 return jsonb_build_object('variantSets',variant_sets,'orphans',orphans,'released',released);
end $$;
revoke all on function public.service_sweep_catalog_updater_rounds(integer) from public,anon,authenticated;
grant execute on function public.service_sweep_catalog_updater_rounds(integer) to service_role;
commit;
