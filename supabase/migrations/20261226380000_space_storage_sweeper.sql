-- 057 T058/T059: the sweeper of R2 spaces (US10, FR-048, FR-049, SC-014, SC-016;
-- research.md R9/R10).
--
-- What was there: the reference triggers (20261226150000) queue an object in
-- space_object_purges when its last reference goes, and nothing deleted it from R2; trashed
-- materials stayed in the trash for good; an expired upload's reservation stayed `uncertain`;
-- deleting a space dropped its ledger by cascade and left every byte in the bucket; a catalog of
-- ten variations took the 050 sweep two passes five minutes apart to take its videos down.
--
-- Now `space-storage-sweeper` (an edge function, woken every minute by pg_cron and at once by the
-- removals below) works these queues, each with a lease and a fence:
--
-- * space_object_purges — service_claim_space_object_purges locks the object row and re-checks
--   it first: content that came back (revived, referenced again, a derivative of a revived
--   original) is kept and its purge withdrawn; content with an open upload of the same content id
--   waits (the multipart writes the very key); otherwise the attempt is counted (from then on the
--   same content is STORAGE_UNAVAILABLE until the purge is done, 20261226150000) and the key handed
--   out. service_finish_space_object_purge marks the object `purged`.
--   An `orphan` purge (no transaction named a reason) is due after a day, every named reason at
--   once (R10).
-- * the trash — service_expire_space_trash deletes what has lain in an R2 trash for 30 days, with
--   reason `trash_expired`, through the same body as «Очистити кошик» (private.space_trash_delete).
-- * uploads — an open upload past its time expires here too (not only when its uploader asks);
--   an `uncertain` reservation is released once the multipart is aborted, or once the bucket's
--   lifecycle rule (config/space-storage/r2-lifecycle.json, one day) has aborted it for us.
-- * a deleted space — a tombstone (private.space_storage_removed_spaces, no FK) outlives the
--   cascade; the sweeper deletes everything under `t/{team}/` and closes it when a listing comes
--   back empty (SC-016).
-- * daily reconciliation (space_storage_reconciliations) — the listing of `t/{team}/` is
--   compared page by page with the ledger in key order: listed keys with nothing behind them are
--   orphans (deleted after 24 hours, FR-049), committed objects the listing passed over are
--   missing (an error, reported through the CLI).
-- * catalogs of an R2 space — the retiring video copies and feed removals of R2 spaces are also
--   claimed here, in one batch, with one zone-cache purge for all their addresses (analysis F2,
--   SC-014: 404 within a minute). The 050 queue, its RPCs and its own sweep are unchanged and
--   still work the same rows (the lease and fence serialize the two); a Drive space's copies are
--   never claimed here.
--
-- Also: a catalog deleted for good while one of its variations still runs cancels that run
-- (20261226250000 §11, replaced), and restoring from an R2 trash a space that is over its limit
-- is refused with STORAGE_QUOTA_EXCEEDED (US10.2).
--
-- Drive spaces: nothing here runs for them. Every new query names an R2 team or an R2 object;
-- the triggers added to shared tables exit on their first line for a Drive row.

-- 1. Queues: leases and fences ------------------------------------------------------------------

alter table public.space_object_purges
  add column fence bigint not null default 0,
  add column lease_until timestamptz,
  add column next_attempt_at timestamptz not null default now();
create index space_object_purges_next_idx on public.space_object_purges (next_attempt_at) where state = 'due';

alter table public.space_uploads
  add column settle_attempts integer not null default 0 check (settle_attempts between 0 and 1000),
  add column settle_next_at timestamptz;

alter table public.space_storage_reconciliations
  add column fence bigint not null default 0,
  add column lease_until timestamptz,
  add column last_key text,
  add column foreign_keys bigint not null default 0 check (foreign_keys >= 0),
  add column orphans_waiting bigint not null default 0 check (orphans_waiting >= 0),
  add column last_error text check (last_error is null or last_error ~ '^[A-Z][A-Z0-9_]{0,95}$');
create index space_storage_reconciliations_team_idx on public.space_storage_reconciliations (team_id, started_at desc);

-- No FK: the tombstone must outlive the team and everything that cascades from it.
create table private.space_storage_removed_spaces (
  team_ref uuid primary key,
  queued_at timestamptz not null default clock_timestamp(),
  fence bigint not null default 0,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  deleted_objects bigint not null default 0 check (deleted_objects >= 0),
  finished_at timestamptz,
  last_error text check (last_error is null or last_error ~ '^[A-Z][A-Z0-9_]{0,95}$')
);
alter table private.space_storage_removed_spaces enable row level security;
alter table private.space_storage_removed_spaces force row level security;
revoke all on private.space_storage_removed_spaces from public, anon, authenticated, service_role;

-- 2. When an object is due ---------------------------------------------------------------------

-- Every named reason is due at once (R10). A purge nobody named comes from a path that did not
-- say why it removed the last reference: it waits a day, the grace an orphan gets (FR-049).
create function private.space_purge_due_at(p_reason text) returns timestamptz
language sql stable set search_path = '' as $$
  select case when p_reason = 'orphan' then now() + interval '24 hours' else now() end;
$$;

create or replace function private.space_object_refs_released() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := coalesce(nullif(pg_catalog.current_setting('soty.space_purge_reason', true), ''), 'orphan');
begin
  if v_reason not in ('trash_expired', 'trash_emptied', 'catalog_deleted', 'space_deleted', 'orphan') then
    v_reason := 'orphan';
  end if;
  if exists (select 1 from public.space_object_refs where object_id = old.object_id) then
    return null;
  end if;
  with released as (
    update public.space_objects set state = 'purge_pending'
    where (id = old.object_id or derivative_of = old.object_id) and state = 'committed'
    returning id, team_id, r2_key
  )
  insert into public.space_object_purges (object_id, team_id, r2_key, due_at, reason)
  select id, team_id, r2_key, private.space_purge_due_at(v_reason), v_reason from released
  on conflict (object_id) do update set due_at = excluded.due_at, reason = excluded.reason,
    state = 'due', deleted_at = null, next_attempt_at = now()
  where public.space_object_purges.state <> 'deleted';
  -- A named reason wants the bytes gone now: wake the sweeper (after commit; best effort).
  if v_reason <> 'orphan' then
    begin
      perform private.invoke_space_storage_sweeper('sweep');
    exception when others then null;
    end;
  end if;
  return null;
end;
$$;

-- 3. The purge queue ---------------------------------------------------------------------------

create function public.service_claim_space_object_purges(p_worker text, p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  q public.space_object_purges%rowtype;
  o public.space_objects%rowtype;
  v_original text;
  v_at timestamptz := clock_timestamp();
  v_out jsonb := '[]'::jsonb;
begin
  if p_worker is null or length(p_worker) not between 8 and 200 or p_limit is null or p_limit not between 1 and 200 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for q in
    select * from public.space_object_purges
     where state = 'due' and due_at <= v_at and next_attempt_at <= v_at and (lease_until is null or lease_until <= v_at)
     order by due_at, object_id
     limit p_limit
     for update skip locked
  loop
    select * into o from public.space_objects where id = q.object_id for update skip locked;
    if not found then continue; end if;
    -- Came back meanwhile (revived, or referenced again without a revive): keep it.
    if o.state = 'committed' or exists (select 1 from public.space_object_refs r where r.object_id = o.id) then
      update public.space_objects set state = 'committed' where id = o.id and state = 'purge_pending';
      delete from public.space_object_purges where object_id = o.id;
      continue;
    end if;
    if o.state = 'purged' then
      update public.space_object_purges set state = 'deleted', deleted_at = coalesce(deleted_at, v_at), lease_until = null
       where object_id = o.id;
      continue;
    end if;
    -- A derivative of an original that was revived lives on with it (the revive takes only the
    -- original back, 20261226150000).
    if o.kind = 'derivative' and exists (
      select 1 from public.space_objects original where original.id = o.derivative_of and original.state = 'committed') then
      update public.space_objects set state = 'committed' where id = o.id;
      delete from public.space_object_purges where object_id = o.id;
      continue;
    end if;
    -- An open upload of the same content writes this very key: wait for it (gap noted in T021).
    v_original := split_part(o.r2_key, '/', 4);
    if exists (
      select 1 from public.space_uploads u
       where u.team_id = o.team_id and u.state in ('open', 'completing')
         and coalesce(u.verified_content_id, u.declared_content_id) = v_original) then
      update public.space_object_purges set next_attempt_at = v_at + interval '5 minutes' where object_id = o.id;
      continue;
    end if;
    update public.space_object_purges
       set attempts = least(attempts + 1, 1000), fence = fence + 1, lease_until = v_at + interval '5 minutes'
     where object_id = o.id
     returning * into q;
    v_out := v_out || jsonb_build_object('objectId', q.object_id, 'teamId', q.team_id, 'key', q.r2_key,
      'fence', q.fence, 'attempt', q.attempts, 'bytes', o.byte_size::text, 'reason', q.reason);
  end loop;
  return v_out;
end;
$$;

create function public.service_finish_space_object_purge(
  p_object uuid, p_fence bigint, p_success boolean, p_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  q public.space_object_purges%rowtype;
  v_bytes bigint;
begin
  select * into q from public.space_object_purges where object_id = p_object for update;
  if not found or q.fence <> p_fence or q.state <> 'due' or q.lease_until is null then
    raise exception 'LEASE_MISMATCH' using errcode = '55000';
  end if;
  select byte_size into v_bytes from public.space_objects where id = p_object;
  if p_success then
    update public.space_object_purges set state = 'deleted', deleted_at = clock_timestamp(), lease_until = null,
      last_error_code = null where object_id = p_object;
    update public.space_objects set state = 'purged', purged_at = clock_timestamp()
     where id = p_object and state = 'purge_pending';
  else
    update public.space_object_purges set lease_until = null,
      last_error_code = case when p_code ~ '^[A-Z][A-Z0-9_]{0,95}$' then p_code else 'STORAGE_UNAVAILABLE' end,
      state = case when q.attempts >= 50 then 'failed' else 'due' end,
      next_attempt_at = clock_timestamp() + least(interval '1 hour', interval '30 seconds' * power(2, least(q.attempts, 7)))
     where object_id = p_object;
  end if;
  insert into private.space_storage_journal (operation_id, attempt, stage, outcome, code, bytes, team_id, client)
  values (p_object, greatest(1, least(q.attempts, 1000)), 'purge', case when p_success then 'ok' else 'failed' end,
    case when p_success then null when p_code ~ '^[A-Z][A-Z0-9_]{0,95}$' then p_code else 'STORAGE_UNAVAILABLE' end,
    v_bytes, q.team_id, 'server/1.0.0');
end;
$$;

-- 4. The trash -----------------------------------------------------------------------------------

-- The body «Очистити кошик» had (20261226270000), for a reason and an optional set of ids.
create function private.space_trash_delete(p_team uuid, p_ids uuid[], p_reason text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_other uuid;
  v_others uuid[];
  v_deleted integer := 0;
  v_previous text := coalesce(pg_catalog.current_setting('soty.space_purge_reason', true), '');
begin
  if p_reason not in ('trash_emptied', 'trash_expired') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('soty.space_purge_reason', p_reason, true);
  -- The chosen trashed materials and everything their trashing hid; deepest first.
  for v_id in
    with recursive chosen as (
      select material.id, 0 as depth from public.team_materials material
      where material.team_id = p_team and material.connection_id is null and material.lifecycle = 'trashed'
        and (p_ids is null or material.id = any(p_ids))
      union
      select child.id, chosen.depth + 1 from public.team_materials child
      join chosen on child.folder_trash_root = chosen.id
      where child.team_id = p_team and child.connection_id is null and child.lifecycle = 'trashed' and chosen.depth < 1000
    )
    select chosen.id from chosen group by chosen.id order by max(chosen.depth) desc, chosen.id
  loop
    begin
      -- T109: its provenance leaves with it, whichever side of the run it was on.
      with gone as (
        delete from public.team_material_links link
         where link.team_id = p_team and link.relation = 'processed_from'
           and (link.derivative_material_id = v_id or link.source_material_id = v_id)
        returning case when link.derivative_material_id = v_id
          then link.source_material_id else link.derivative_material_id end as other)
      select coalesce(array_agg(distinct other), '{}') into v_others from gone;
      delete from public.team_materials where id = v_id and team_id = p_team and lifecycle = 'trashed';
      if found then
        v_deleted := v_deleted + 1;
        foreach v_other in array v_others loop
          perform private.space_material_ref_sync(v_other);
        end loop;
      end if;
    exception when foreign_key_violation then
      -- Still referenced (a task, a catalog, another kind of link, a child that stays): it stays
      -- in the trash, and so do its links (the subtransaction rolls them back).
      null;
    end;
  end loop;
  perform pg_catalog.set_config('soty.space_purge_reason', v_previous, true);
  return v_deleted;
end;
$$;
revoke all on function private.space_trash_delete(uuid, uuid[], text) from public, anon, authenticated;

create or replace function public.service_empty_space_trash(p_actor uuid, p_team uuid, p_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_deleted integer;
  v_queued integer;
  v_revision bigint;
begin
  if p_ids is not null and cardinality(p_ids) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform 1 from public.teams where id = p_team for no key update;
  perform private.require_space_actor(p_team, p_actor, 'delete');
  select count(*) into v_queued from public.space_object_purges where team_id = p_team and state = 'due';
  v_deleted := private.space_trash_delete(p_team, p_ids, 'trash_emptied');
  v_queued := (select count(*) from public.space_object_purges where team_id = p_team and state = 'due') - v_queued;
  if v_deleted > 0 then
    v_revision := private.space_content_changed(p_team, null, true);
  else
    select content_revision into v_revision from public.teams where id = p_team;
  end if;
  return jsonb_build_object('deleted', v_deleted, 'purgesQueued', greatest(v_queued, 0), 'contentRevision', v_revision::text);
end;
$function$;

-- Thirty days in the trash (US10.2): the oldest trash roots of R2 spaces go for good.
create function public.service_expire_space_trash(p_limit integer default 200) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  t record;
  v_deleted integer := 0;
  v_team_deleted integer;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for t in
    select material.team_id, array_agg(material.id order by material.trashed_at) as ids
    from (
      select material.team_id, material.id, material.trashed_at
      from public.teams team
      join public.team_materials material on material.team_id = team.id
      where team.storage_backend = 'r2' and material.connection_id is null and material.lifecycle = 'trashed'
        and material.folder_trash_root is null and material.trashed_at < now() - interval '30 days'
      order by material.trashed_at
      limit p_limit) material
    group by material.team_id
  loop
    perform 1 from public.teams where id = t.team_id for no key update;
    v_team_deleted := private.space_trash_delete(t.team_id, t.ids, 'trash_expired');
    if v_team_deleted > 0 then
      perform private.space_content_changed(t.team_id, null, true);
    end if;
    -- What stays (still referenced) is not tried again every minute: its clock restarts.
    update public.team_materials set trashed_at = now()
     where team_id = t.team_id and id = any(t.ids) and lifecycle = 'trashed';
    v_deleted := v_deleted + v_team_deleted;
  end loop;
  return v_deleted;
end;
$$;

-- Restoring into a space over its limit (US10.2): nothing comes back until room is made. Trashed
-- bytes still count, so a restore never grows the space; it is refused only when the space is
-- already past what it may hold (the limit was lowered, or the space filled meanwhile).
create function private.space_restore_within_capacity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if not exists (select 1 from public.teams where id = new.team_id and storage_backend = 'r2') then
    return new;
  end if;
  if private.space_used_bytes(new.team_id) + private.space_reserved_bytes(new.team_id)
     > private.space_capacity_bytes(new.team_id) then
    raise exception 'STORAGE_QUOTA_EXCEEDED' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function private.space_restore_within_capacity() from public, anon, authenticated;
create trigger space_restore_within_capacity before update of lifecycle on public.team_materials
  for each row when (old.lifecycle = 'trashed' and new.lifecycle = 'active'
    and new.connection_id is null and new.space_object_id is not null)
  execute function private.space_restore_within_capacity();

-- 5. Uploads --------------------------------------------------------------------------------------

-- Open uploads past their time expire here as they do when their uploader asks
-- (service_space_upload_session): the reservation is released, or `uncertain` when a multipart
-- may exist.
create function public.service_expire_space_uploads(p_limit integer default 200) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  u public.space_uploads%rowtype;
  n integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for u in
    select * from public.space_uploads where state = 'open' and expires_at <= now()
     order by expires_at limit p_limit for update skip locked
  loop
    update public.space_uploads set state = 'expired', updated_at = now() where id = u.id;
    update public.space_storage_reservations
       set state = case when u.r2_upload_id is null then 'released' else 'uncertain' end,
           settled_at = case when u.r2_upload_id is null then now() else null end
     where id = u.reservation_id and state = 'reserved';
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- The uploads whose reservation waits for their multipart to be closed.
create function public.service_claim_space_uncertain_uploads(p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u record;
  v_out jsonb := '[]'::jsonb;
begin
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for u in
    select upload.id, upload.team_id, upload.declared_content_id, upload.r2_upload_id, upload.expires_at
      from public.space_uploads upload
      join public.space_storage_reservations reservation on reservation.id = upload.reservation_id
     where reservation.state = 'uncertain' and upload.state in ('expired', 'aborted', 'rejected')
       and (upload.settle_next_at is null or upload.settle_next_at <= clock_timestamp())
     order by upload.expires_at limit p_limit
     for update of upload skip locked
  loop
    update public.space_uploads set settle_attempts = least(settle_attempts + 1, 1000),
      settle_next_at = clock_timestamp() + interval '15 minutes' where id = u.id;
    v_out := v_out || jsonb_build_object('uploadId', u.id, 'teamId', u.team_id,
      'key', 't/' || u.team_id::text || '/o/' || u.declared_content_id, 'r2UploadId', u.r2_upload_id,
      -- The bucket's lifecycle rule aborts any multipart older than a day (r2-lifecycle.json).
      'lifecycleAborted', u.expires_at < now() - interval '24 hours');
  end loop;
  return v_out;
end;
$$;

create function public.service_settle_space_uncertain_upload(p_upload uuid, p_closed boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare u public.space_uploads%rowtype;
begin
  select * into u from public.space_uploads where id = p_upload for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not p_closed and u.expires_at >= now() - interval '24 hours' then
    return false;
  end if;
  update public.space_storage_reservations set state = 'released', settled_at = now()
   where id = u.reservation_id and state = 'uncertain';
  update public.space_uploads set settle_next_at = null where id = u.id;
  return found;
end;
$$;

-- 6. A deleted space ------------------------------------------------------------------------------

create function private.space_storage_before_team_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.space_storage_removed_spaces (team_ref) values (old.id)
  on conflict (team_ref) do update set finished_at = null, next_attempt_at = clock_timestamp(), last_error = null;
  begin
    perform private.invoke_space_storage_sweeper('sweep');
  exception when others then null;
  end;
  return old;
end;
$$;
revoke all on function private.space_storage_before_team_delete() from public, anon, authenticated;
create trigger space_storage_before_team_delete before delete on public.teams
  for each row when (old.storage_backend = 'r2')
  execute function private.space_storage_before_team_delete();

create function public.service_claim_space_removed_space(p_worker text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r private.space_storage_removed_spaces%rowtype; v_at timestamptz := clock_timestamp();
begin
  if p_worker is null or length(p_worker) not between 8 and 200 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into r from private.space_storage_removed_spaces
   where finished_at is null and next_attempt_at <= v_at and (lease_until is null or lease_until <= v_at)
     -- A team that came back under the same id (it cannot: ids are random) is not touched.
     and not exists (select 1 from public.teams where id = team_ref)
   order by next_attempt_at, queued_at limit 1 for update skip locked;
  if not found then return null; end if;
  update private.space_storage_removed_spaces set fence = fence + 1, attempts = attempts + 1,
    lease_until = v_at + interval '3 minutes'
   where team_ref = r.team_ref returning * into r;
  return jsonb_build_object('teamId', r.team_ref, 'fence', r.fence);
end;
$$;

-- p_empty: the last listing of the prefix came back empty — the space has 0 objects left.
create function public.service_finish_space_removed_space(
  p_team uuid, p_fence bigint, p_deleted integer, p_empty boolean, p_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r private.space_storage_removed_spaces%rowtype;
begin
  select * into r from private.space_storage_removed_spaces where team_ref = p_team for update;
  if not found or r.fence <> p_fence or r.finished_at is not null then
    raise exception 'LEASE_MISMATCH' using errcode = '55000';
  end if;
  update private.space_storage_removed_spaces set
    lease_until = null,
    deleted_objects = deleted_objects + greatest(coalesce(p_deleted, 0), 0),
    finished_at = case when p_empty and p_code is null then clock_timestamp() end,
    last_error = case when p_code ~ '^[A-Z][A-Z0-9_]{0,95}$' then p_code end,
    next_attempt_at = case when p_code is null then clock_timestamp()
      else clock_timestamp() + least(interval '1 hour', interval '30 seconds' * power(2, least(r.attempts, 7))) end
   where team_ref = p_team;
  if p_empty and p_code is null then
    insert into private.space_storage_journal (operation_id, attempt, stage, outcome, code, bytes, team_id, client)
    values (p_team, greatest(1, least(r.attempts, 1000)), 'purge', 'ok', null, null, p_team, 'server/1.0.0');
  end if;
end;
$$;

-- 7. Daily reconciliation -------------------------------------------------------------------------

-- One reconciliation per R2 space a day; the minute sweep carries each through, page by page.
create function public.service_start_space_reconciliations() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.space_storage_reconciliations (team_id)
  select team.id from public.teams team
   where team.storage_backend = 'r2'
     and not exists (select 1 from public.space_storage_reconciliations r
       where r.team_id = team.id and (r.state = 'running' or r.started_at > now() - interval '20 hours'));
  get diagnostics n = row_count;
  return n;
end;
$$;

create function public.service_claim_space_reconciliation(p_worker text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.space_storage_reconciliations%rowtype; v_at timestamptz := clock_timestamp();
begin
  if p_worker is null or length(p_worker) not between 8 and 200 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- A space deleted meanwhile has nothing to reconcile: its tombstone empties it.
  update public.space_storage_reconciliations set state = 'failed', finished_at = v_at, last_error = 'NOT_FOUND'
   where state = 'running' and team_id is not null
     and not exists (select 1 from public.teams where id = team_id);
  select * into r from public.space_storage_reconciliations
   where state = 'running' and team_id is not null and (lease_until is null or lease_until <= v_at)
   order by started_at limit 1 for update skip locked;
  if not found then return null; end if;
  update public.space_storage_reconciliations set fence = fence + 1, lease_until = v_at + interval '3 minutes'
   where id = r.id returning * into r;
  return jsonb_build_object('reconciliationId', r.id, 'teamId', r.team_id, 'fence', r.fence, 'lastKey', r.last_key);
end;
$$;

-- One page of the listing, in key order (S3 lists by UTF-8 bytes: collate "C"). p_objects:
-- [{key, etag, lastModified}], keys of this space's documented shapes only. Answers the orphans
-- past their grace, for the sweeper to delete; the rest are counted and wait.
create function public.service_space_reconcile_page(
  p_reconciliation uuid, p_fence bigint, p_objects jsonb, p_foreign integer, p_final boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.space_storage_reconciliations%rowtype;
  v_prefix text;
  v_last text;
  v_listed integer;
  v_orphans jsonb;
  v_found integer;
  v_waiting integer;
  v_missing integer;
begin
  select * into r from public.space_storage_reconciliations where id = p_reconciliation for update;
  if not found or r.fence <> p_fence or r.state <> 'running' or r.lease_until is null then
    raise exception 'LEASE_MISMATCH' using errcode = '55000';
  end if;
  if p_objects is null or jsonb_typeof(p_objects) <> 'array' or jsonb_array_length(p_objects) > 1000
     or p_foreign is null or p_foreign < 0 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_prefix := 't/' || r.team_id::text || '/';
  select count(*), count(distinct item ->> 'key'),
    max((item ->> 'key') collate "C")
    into v_listed, v_found, v_last
    from jsonb_array_elements(p_objects) item
   where left(item ->> 'key', length(v_prefix)) = v_prefix;
  if v_listed <> jsonb_array_length(p_objects) or v_found <> v_listed then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  -- Listed with nothing behind it: no live object row, no open upload of its content or staging.
  with page as (
    select (item ->> 'key') collate "C" as key, item ->> 'etag' as etag,
      nullif(item ->> 'lastModified', '')::timestamptz as modified
    from jsonb_array_elements(p_objects) item
  ), unknown as (
    select page.key, page.etag, page.modified from page
     where not exists (select 1 from public.space_objects o
         where o.team_id = r.team_id and o.r2_key = page.key and o.state in ('committed', 'purge_pending'))
       and not exists (select 1 from public.space_uploads u
         where u.team_id = r.team_id and u.state in ('open', 'completing')
           and (split_part(page.key, '/', 4) in (u.declared_content_id, coalesce(u.verified_content_id, ''))
             or split_part(page.key, '/', 4) = u.id::text))
  )
  select count(*), count(*) filter (where modified is null or modified >= now() - interval '24 hours'),
    coalesce(jsonb_agg(jsonb_build_object('key', key, 'etag', etag))
      filter (where modified < now() - interval '24 hours'), '[]'::jsonb)
    into v_found, v_waiting, v_orphans
  from unknown;

  -- Committed before this reconciliation began, in the range this page covers, and not listed.
  select count(*) into v_missing from public.space_objects o
   where o.team_id = r.team_id and o.state = 'committed' and o.created_at < r.started_at
     and (r.last_key is null or (o.r2_key collate "C") > (r.last_key collate "C"))
     and (p_final or (v_last is not null and (o.r2_key collate "C") <= (v_last collate "C")))
     and not exists (select 1 from jsonb_array_elements(p_objects) item where item ->> 'key' = o.r2_key);

  update public.space_storage_reconciliations set
    listed = listed + v_listed,
    foreign_keys = foreign_keys + p_foreign,
    orphans_found = orphans_found + v_found,
    orphans_waiting = orphans_waiting + v_waiting,
    missing = missing + v_missing,
    last_key = coalesce(v_last, last_key),
    lease_until = clock_timestamp() + interval '3 minutes'
   where id = r.id returning * into r;

  if p_final then
    update public.space_storage_reconciliations set
      state = 'done', finished_at = clock_timestamp(), lease_until = null,
      ledger = (select count(*) from public.space_objects o
        where o.team_id = r.team_id and o.state = 'committed' and o.created_at < r.started_at)
     where id = r.id returning * into r;
    insert into private.space_storage_journal (operation_id, attempt, stage, outcome, code, bytes, team_id, client)
    values (r.id, 1, 'reconcile', case when r.missing = 0 then 'ok' else 'failed' end,
      case when r.missing = 0 then null else 'NOT_FOUND' end, null, r.team_id, 'server/1.0.0');
  end if;
  return jsonb_build_object('orphans', v_orphans, 'missing', v_missing, 'listed', v_listed);
end;
$$;

create function public.service_space_reconcile_orphans_deleted(
  p_reconciliation uuid, p_fence bigint, p_deleted integer, p_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.space_storage_reconciliations%rowtype;
begin
  select * into r from public.space_storage_reconciliations where id = p_reconciliation for update;
  if not found or r.fence <> p_fence then
    raise exception 'LEASE_MISMATCH' using errcode = '55000';
  end if;
  update public.space_storage_reconciliations set
    orphans_deleted = orphans_deleted + greatest(coalesce(p_deleted, 0), 0),
    last_error = case when p_code ~ '^[A-Z][A-Z0-9_]{0,95}$' then p_code else last_error end
   where id = r.id;
end;
$$;

-- A listing that failed: the reconciliation keeps its place and is tried again after a pause.
create function public.service_space_reconcile_failed(p_reconciliation uuid, p_fence bigint, p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.space_storage_reconciliations%rowtype;
begin
  select * into r from public.space_storage_reconciliations where id = p_reconciliation for update;
  if not found or r.fence <> p_fence then
    raise exception 'LEASE_MISMATCH' using errcode = '55000';
  end if;
  update public.space_storage_reconciliations set
    lease_until = clock_timestamp() + interval '10 minutes',
    last_error = case when p_code ~ '^[A-Z][A-Z0-9_]{0,95}$' then p_code else 'STORAGE_UNAVAILABLE' end
   where id = r.id;
end;
$$;

-- 8. Catalogs of R2 spaces: their addresses down within a minute (SC-014) --------------------------

-- The retiring copies of R2 spaces' catalogs, a batch at once, under 050's lease and fence (the
-- 050 sweep may take the same rows: whoever holds the lease deletes, the other skips). Finished
-- with service_catalog_video_r2_mark_deleted after one zone purge for the whole batch.
create function public.service_space_catalog_claim_retire(p_worker text, p_limit integer default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c private.catalog_video_r2_copies%rowtype;
  v_at timestamptz := clock_timestamp();
  v_out jsonb := '[]'::jsonb;
begin
  if p_worker is null or length(p_worker) not between 8 and 200 or p_limit is null or p_limit not between 1 and 30 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('catalog-video-r2-retire', 0));
  for c in
    select copy.* from private.catalog_video_r2_copies copy
      join public.teams team on team.id = copy.team_id and team.storage_backend = 'r2'
     where copy.state = 'retiring' and copy.retire_after <= v_at and copy.next_attempt_at <= v_at
       and (copy.lease_until is null or copy.lease_until <= v_at)
       and not exists (select 1 from private.catalog_video_r2_uses u where u.copy_id = copy.id)
     order by copy.retire_after limit p_limit
     for update of copy skip locked
  loop
    update private.catalog_video_r2_copies set lease_owner = p_worker, lease_until = v_at + interval '90 seconds',
      fence = fence + 1, attempts = attempts + 1
     where id = c.id returning * into c;
    v_out := v_out || jsonb_build_object('copyId', c.id, 'teamId', c.team_id, 'fence', c.fence, 'objectKey', c.object_key);
  end loop;
  return v_out;
end;
$$;

-- The feeds of R2 spaces' catalogs deleted for good, a batch at once (050's queue, its fence;
-- finished with service_catalog_feed_finish_removal).
create function public.service_space_catalog_claim_feed_removals(p_worker text, p_limit integer default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r private.catalog_feed_removals%rowtype;
  v_at timestamptz := clock_timestamp();
  v_out jsonb := '[]'::jsonb;
begin
  if p_worker is null or length(p_worker) not between 8 and 200 or p_limit is null or p_limit not between 1 and 30 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for r in
    select removal.* from private.catalog_feed_removals removal
      join public.teams team on team.id = removal.team_ref and team.storage_backend = 'r2'
     where removal.removed_at is null and removal.next_attempt_at <= v_at
       and (removal.lease_until is null or removal.lease_until <= v_at)
     order by removal.next_attempt_at, removal.queued_at limit p_limit
     for update of removal skip locked
  loop
    if exists (select 1 from public.team_product_catalogs where feed_id = r.feed_id) then
      update private.catalog_feed_removals set removed_at = v_at, last_error = 'FEED_IN_USE' where feed_id = r.feed_id;
      continue;
    end if;
    update private.catalog_feed_removals set fence = fence + 1, lease_until = v_at + interval '60 seconds',
      attempts = attempts + 1 where feed_id = r.feed_id returning * into r;
    v_out := v_out || jsonb_build_object('feedId', r.feed_id, 'fence', r.fence);
  end loop;
  return v_out;
end;
$$;

-- 9. A catalog deleted for good stops its variations' runs (20261226250000 §11, replaced) ------------

create or replace function private.space_catalog_variant_removed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_previous text := coalesce(pg_catalog.current_setting('soty.space_purge_reason', true), '');
begin
  -- A run still making this variation is canceled: its result has nowhere to go (US10.1).
  if old.operation_id is not null and exists (
    select 1 from public.team_operations o where o.id = old.operation_id and o.state in ('pending', 'running')) then
    perform public.service_transition_team_operation(old.operation_id, 'canceled', 'canceled', 0, null, null, false);
  end if;
  if old.output_material_id is null then return null; end if;
  perform pg_catalog.set_config('soty.space_purge_reason', 'catalog_deleted', true);
  begin
    delete from public.team_material_links
     where team_id = old.team_id and derivative_material_id = old.output_material_id and relation = 'processed_from';
    delete from public.team_materials
     where id = old.output_material_id and team_id = old.team_id and connection_id is null;
  exception when foreign_key_violation then
    null;
  end;
  perform pg_catalog.set_config('soty.space_purge_reason', v_previous, true);
  return null;
end;
$$;

-- 10. Waking the sweeper --------------------------------------------------------------------------

create function private.space_storage_sweeper_endpoint() returns text
language sql stable security definer set search_path = '' as $$
  select case when e ~ '^https?://[^/]+/functions/v1/space-storage-sweeper$' then e else null end
  from (select regexp_replace(decrypted_secret, '/catalog-sync/?$', '/space-storage-sweeper') e
          from vault.decrypted_secrets where name = 'wishly_catalog_sync_url'
         order by created_at desc limit 1) x;
$$;

create function private.space_storage_sweeper_has_work() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.space_object_purges
      where state = 'due' and due_at <= now() and next_attempt_at <= now() and (lease_until is null or lease_until <= now()))
    or exists (select 1 from private.space_storage_removed_spaces where finished_at is null and next_attempt_at <= now())
    or exists (select 1 from public.space_storage_reconciliations where state = 'running')
    or exists (select 1 from public.space_uploads where state = 'open' and expires_at <= now())
    or exists (select 1 from public.space_storage_reservations where state = 'uncertain')
    or exists (select 1 from public.teams team
      join private.catalog_video_r2_copies copy on copy.team_id = team.id
      where team.storage_backend = 'r2' and copy.state = 'retiring' and copy.retire_after <= now())
    or exists (select 1 from public.teams team
      join private.catalog_feed_removals removal on removal.team_ref = team.id
      where team.storage_backend = 'r2' and removal.removed_at is null and removal.next_attempt_at <= now())
    or exists (select 1 from public.teams team
      join public.team_materials material on material.team_id = team.id
      where team.storage_backend = 'r2' and material.connection_id is null and material.lifecycle = 'trashed'
        and material.folder_trash_root is null and material.trashed_at < now() - interval '30 days');
$$;

create function private.invoke_space_storage_sweeper(p_route text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare endpoint text; secret text; rid bigint;
begin
  if p_route not in ('sweep', 'reconcile') then raise exception 'INVALID_INPUT'; end if;
  -- Once per transaction: a delete of a hundred rows wakes it once.
  if pg_catalog.current_setting('soty.space_sweeper_woken', true) = p_route then return null; end if;
  -- Every caller queues its work before it wakes, so the first look in a transaction is the one.
  perform pg_catalog.set_config('soty.space_sweeper_woken', p_route, true);
  endpoint := private.space_storage_sweeper_endpoint();
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'wishly_catalog_sync_secret'
   order by created_at desc limit 1;
  if endpoint is null or secret is null or length(secret) < 32 then return null; end if;
  -- Work queued by this very transaction is visible here; nothing to do means no call.
  if p_route = 'sweep' and not private.space_storage_sweeper_has_work() then return null; end if;
  select net.http_post(url := endpoint,
    headers := jsonb_build_object('content-type', 'application/json', 'x-catalog-sync-secret', secret),
    body := jsonb_build_object('route', p_route), timeout_milliseconds := 65000) into rid;
  return rid;
end;
$$;

-- An R2 catalog's copies became due for deletion (its trash, 20261207400200), or its feed was
-- queued for removal: wake the sweeper so the addresses go within a minute, not at the next
-- five-minute 050 sweep. Exits on its first line for a Drive team.
create function private.space_storage_wake_for_catalog() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_team uuid;
begin
  v_team := (to_jsonb(new) ->> case when tg_table_name = 'catalog_feed_removals' then 'team_ref' else 'team_id' end)::uuid;
  if v_team is null or not exists (select 1 from public.teams where id = v_team and storage_backend = 'r2') then
    return null;
  end if;
  begin
    perform private.invoke_space_storage_sweeper('sweep');
  exception when others then null;
  end;
  return null;
end;
$$;
revoke all on function private.space_storage_wake_for_catalog() from public, anon, authenticated;
create trigger space_storage_wake_for_catalog after update of state, retire_after on private.catalog_video_r2_copies
  for each row when (new.state = 'retiring')
  execute function private.space_storage_wake_for_catalog();
create trigger space_storage_wake_for_catalog after insert or update of removed_at, next_attempt_at on private.catalog_feed_removals
  for each row when (new.removed_at is null)
  execute function private.space_storage_wake_for_catalog();

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('soty-space-storage-sweeper', '* * * * *',
      $cron$select private.invoke_space_storage_sweeper('sweep')$cron$);
    perform cron.schedule('soty-space-storage-reconcile', '23 3 * * *',
      $cron$select private.invoke_space_storage_sweeper('reconcile')$cron$);
  end if;
end $$;

-- 11. Grants ---------------------------------------------------------------------------------------

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text as signature, n.nspname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'public' and p.proname in (
        'service_claim_space_object_purges', 'service_finish_space_object_purge', 'service_expire_space_trash',
        'service_expire_space_uploads', 'service_claim_space_uncertain_uploads', 'service_settle_space_uncertain_upload',
        'service_claim_space_removed_space', 'service_finish_space_removed_space', 'service_start_space_reconciliations',
        'service_claim_space_reconciliation', 'service_space_reconcile_page', 'service_space_reconcile_orphans_deleted',
        'service_space_reconcile_failed', 'service_space_catalog_claim_retire', 'service_space_catalog_claim_feed_removals'))
        or (n.nspname = 'private' and p.proname in (
        'space_purge_due_at', 'space_storage_sweeper_endpoint', 'space_storage_sweeper_has_work',
        'invoke_space_storage_sweeper'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
    if f.nspname = 'public' then
      execute format('grant execute on function %s to service_role', f.signature);
    end if;
  end loop;
end $$;
revoke all on function public.service_empty_space_trash(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.service_empty_space_trash(uuid, uuid, uuid[]) to service_role;
