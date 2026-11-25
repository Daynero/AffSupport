-- 072 (catalog never hangs silently), manager package П5: what a running catalog lets you touch,
-- how alive its work is, and which Drive folder it belongs to.
--
-- Owner, 2026-11-25:
-- 1. «Поки каталог оновлюється, можна клікати налаштування — хаос». The manager now locks a
--    catalog's settings while its update runs; the server refuses the same change, so a second
--    tab, an old page or a race with a scheduled round cannot change a catalog mid-round:
--    patch_team_catalog_update_profile answers WRONG_STATE (55000, as the variant admission does
--    for the same reason) while the catalog holds a round or a delivery check. The space-wide
--    interval setter (assistant) keeps working: it only moves the next run.
-- 2. «Бачив момент: наче ще оновлюється, а замість кнопки стоп — кнопка оновити». The row's
--    stop button followed only the round, the progress followed the round, the delivery check and
--    every video set. The manager now reads one answer for both; to say honestly whether the work
--    is moving, each row carries the freshest sign of life the server has (a variant heartbeat,
--    the round's stage report, a worker's live lease, a re-stitch job's progress), when a waiting
--    round tries again, and since when its last error stands.
-- 3. «Поточна проблема: Підключення до Drive треба поновити…» on catalogs of a folder the space
--    no longer uses. A catalog belongs to the Drive connection its sheet was found through.
--    Replacing the space's folder with another one detaches the old connection; its catalogs
--    stay where they are and no re-authorisation can reach them, yet every closer reported
--    NEEDS_REAUTH. Now:
--    a. close_unreachable_catalog_rounds names a detached connection CONNECTION_DETACHED;
--    b. the manager row says which folder the catalog is in and which one the space uses, so the
--       web can tell «reconnect Drive» from «this catalog is in your previous folder»;
--    c. connecting the same folder again (disconnect, then connect: a new connection row) hands
--       the detached connection's materials to the new one at once, instead of leaving them to
--       whatever the first scan finds. Replacing a folder by itself (same root) already keeps the
--       connection row and needs nothing.
--
-- Nothing raises 40001. No new table or column; the trigger only moves team_materials between two
-- connections of the same space and root.
-- Rollback: restore private.catalog_registry_video_publication from 20261221116000; drop the two
-- triggers on team_drive_connections and their function, drop
-- private.catalog_has_active_work and private.catalog_manager_runtime, restore
-- list_team_catalog_manager_snapshot from 20261221180000 (or the latest earlier definition), and
-- re-run the bodies of patch_team_catalog_update_profile and close_unreachable_catalog_rounds
-- without the lines marked «072 П5».

-- 1. A running catalog's settings are not changed mid-round. -------------------------------------
create or replace function private.catalog_has_active_work(p_catalog uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.team_catalog_updater_items i
                where i.catalog_material_id=p_catalog
                  and (i.round_due_at is not null or i.reconciliation_required))
     or exists(select 1 from private.catalog_update_reconciliations r where r.catalog_material_id=p_catalog)
$$;
revoke all on function private.catalog_has_active_work(uuid) from public,anon,authenticated;

do $patch$
declare d text;
  find text:=$find$if changed.version is distinct from p_expected_version then raise exception 'STALE_RESULT' using errcode = 'PT409'; end if;$find$;
begin
 select pg_get_functiondef('public.patch_team_catalog_update_profile(uuid,uuid,bigint,jsonb)'::regprocedure) into d;
 if strpos(d,find)=0 then raise exception 'CATALOG_PROFILE_LOCK_PATCH_MISSING';end if;
 if strpos(d,'catalog_has_active_work')=0 then
  d:=replace(d,find,find||$add$
  -- 072 П5: settings stay as the running round took them; stop it or wait for it to end.
  if private.catalog_has_active_work(p_catalog) then raise exception 'WRONG_STATE' using errcode = '55000'; end if;$add$);
  execute d;
 end if;
end $patch$;

-- 3a. A detached connection is not a Drive that needs signing in again. ----------------------------
do $patch$
declare d text;
  find text:=$find$when 'pending' then 'DRIVE_UNAVAILABLE'$find$;
begin
 select pg_get_functiondef('private.close_unreachable_catalog_rounds()'::regprocedure) into d;
 if strpos(d,find)=0 then raise exception 'CATALOG_UNREACHABLE_PATCH_MISSING';end if;
 if strpos(d,'CONNECTION_DETACHED')=0 then
  d:=replace(d,find,find||$add$
                         -- 072 П5: the space moved to another folder; reconnecting cannot help.
                         when 'detached' then 'CONNECTION_DETACHED'$add$);
  execute d;
 end if;
end $patch$;

-- 2 + 3b. What the manager row needs to tell moving work from standing work, and which folder. ----
create or replace function private.catalog_manager_runtime(p_team uuid,p_catalog uuid,p_set uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare i public.team_catalog_updater_items%rowtype;beat timestamptz;sheet_connection public.team_drive_connections%rowtype;
  space_folder text;error_at timestamptz;
begin
 select * into i from public.team_catalog_updater_items where catalog_material_id=p_catalog and team_id=p_team;
 select c.last_update_error_at into error_at from public.team_product_catalogs c where c.material_id=p_catalog and c.team_id=p_team;
 if i.round_due_at is not null then
  select greatest(
    (select p.updated_at from private.catalog_update_progress p
      where p.catalog_material_id=p_catalog and p.updated_at>=i.round_due_at),
    (select o.updated_at from private.catalog_restitch_jobs j join public.team_operations o on o.id=j.operation_id
      where j.catalog_material_id=p_catalog and j.state='leased' and j.lease_expires_at>clock_timestamp()))
   into beat;
 end if;
 if p_set is not null then
  beat:=greatest(beat,(select max(v.heartbeat_at) from private.catalog_video_variants v
    where v.video_set_id in(select x.set_id from private.catalog_round_sets(p_set) x) and v.state='working'));
 end if;
 select c.* into sheet_connection from public.team_materials m
   join public.team_drive_connections c on c.id=m.connection_id and c.team_id=m.team_id
  where m.id=p_catalog and m.team_id=p_team;
 select c.root_folder_name into space_folder from public.team_drive_connections c
  where c.team_id=p_team and c.state<>'detached' limit 1;
 return jsonb_strip_nulls(jsonb_build_object(
  'last_update_error_at',error_at,
  'work_heartbeat_at',beat,
  'round_next_attempt_at',case when i.round_due_at is not null then i.next_attempt_at end,
  -- A worker holds the round now (a variant round's request lease is 'infinity' and says nothing).
  'round_worker_live',case when i.round_due_at is not null and i.lease_owner is not null
    and i.lease_owner not like 'catalog-variants:%' and i.lease_expires_at>clock_timestamp()
    and i.lease_expires_at<clock_timestamp()+interval '1 hour' then true end,
  'drive_connection',case when sheet_connection.id is not null then jsonb_strip_nulls(jsonb_build_object(
    'state',sheet_connection.state,
    'folderName',sheet_connection.root_folder_name,
    'spaceFolderName',case when sheet_connection.state='detached' then space_folder end)) end));
end $$;
revoke all on function private.catalog_manager_runtime(uuid,uuid,uuid) from public,anon,authenticated;

create or replace function public.list_team_catalog_manager_snapshot(p_team uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare identities jsonb;
begin
 if auth.uid() is null or private.can(p_team,'view',auth.uid()) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 identities:=coalesce(public.list_team_catalog_progress_identity(p_team),'{}'::jsonb);
 return jsonb_build_object(
  'observed_at',statement_timestamp(),
  'catalogs',coalesce((select jsonb_agg(to_jsonb(c)||coalesce(identities->(c.catalog_id::text),'{}'::jsonb)
     ||jsonb_build_object('video_generation',g.vg,'video_publication',private.catalog_registry_video_publication(p_team,c.catalog_id))
     -- 072 П5: sign of life, retry time, the catalog's Drive folder.
     ||private.catalog_manager_runtime(p_team,c.catalog_id,(g.vg->>'setId')::uuid))
   from public.list_team_product_catalogs(p_team)c
   cross join lateral (select private.catalog_registry_video_generation(p_team,c.catalog_id) vg) g),'[]'::jsonb),
  'profiles',coalesce((select jsonb_agg(to_jsonb(p)) from public.list_team_catalog_update_profiles(p_team)p),'[]'::jsonb));
end;$function$;

-- 3c. The same folder connected again takes its materials back at once. -------------------------
create or replace function private.team_drive_connection_adopts_same_root()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 -- Connecting must never fail because of this: the first scan adopts what it finds anyway.
 begin
  update public.team_materials m set connection_id=new.id
    from public.team_drive_connections previous
   where previous.team_id=new.team_id and previous.id<>new.id and previous.state='detached'
     and previous.root_folder_id=new.root_folder_id and previous.drive_kind=new.drive_kind
     and previous.drive_id is not distinct from new.drive_id
     and m.team_id=new.team_id and m.connection_id=previous.id;
 exception when others then
  raise warning 'same-root material adoption skipped: %',sqlstate;
 end;
 return null;
end $$;
revoke all on function private.team_drive_connection_adopts_same_root() from public,anon,authenticated;

drop trigger if exists team_drive_connections_adopt_same_root_insert on public.team_drive_connections;
create trigger team_drive_connections_adopt_same_root_insert
  after insert on public.team_drive_connections
  for each row when (new.state='connected')
  execute function private.team_drive_connection_adopts_same_root();
drop trigger if exists team_drive_connections_adopt_same_root_update on public.team_drive_connections;
create trigger team_drive_connections_adopt_same_root_update
  after update of state on public.team_drive_connections
  for each row when (old.state is distinct from new.state and new.state='connected')
  execute function private.team_drive_connection_adopts_same_root();

-- 4. A link that stopped is seen in the manager's row, not only inside its dialog (072, П5/П3).
--    The row carried only a scheduled link's time; a blocked or unconfirmed write of any link
--    said nothing until someone opened «Відкладене відеопосилання». The row now also carries the
--    job's state and blocked reason; an immediate link appears only while it is blocked or
--    unconfirmed (its due time is null — a released web, which needs one, shows nothing as before).
create or replace function private.catalog_registry_video_publication(p_team uuid, p_catalog uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $function$
 select jsonb_build_object(
  'due_at', p.due_at,
  'time_zone', p.time_zone,
  'waiting_for_videos', coalesce((t.kind = 'video_set' and s.state is distinct from 'ready')
      or (t.kind = 'creatives' and exists(select 1 from private.catalog_publication_target_segments g join private.catalog_video_sets x on x.id = g.video_set_id
                                           where g.target_id = t.id and x.state is distinct from 'ready')), false),
  'job_state', j.state,
  'blocked_reason', j.blocked_reason)
 from private.catalog_video_publication_policies p
 join private.catalog_video_publication_jobs j
   on j.catalog_material_id = p.catalog_material_id
  and j.team_id = p.team_id
  and j.state not in ('published', 'superseded', 'held')
 join private.catalog_publication_targets t on t.id = j.target_id and t.team_id = j.team_id
 left join private.catalog_video_sets s on s.id = t.video_set_id and s.team_id = t.team_id
 where p.team_id = p_team and p.catalog_material_id = p_catalog
   and (p.mode = 'scheduled' or j.state in ('blocked', 'unknown'))
 order by j.revision desc
 limit 1
$function$;
