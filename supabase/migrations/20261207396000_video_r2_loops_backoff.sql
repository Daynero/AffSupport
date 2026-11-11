-- The two per-minute loops of the catalog video R2 worker, brought to the rule
-- 20261207395000 set for every 1.4.3 settle loop.
--
-- service_catalog_video_r2_reconcile_pending already ran each catalog in its
-- own subtransaction, but swallowed the error silently and kept no backoff: a
-- catalog that always raises kept its place at the head of the list (ordered
-- by preference time) on every pass and took one of the pass's slots forever.
-- It now records the failure with a closed code, skips the catalog while it is
-- backed off (2 minutes, doubling, at most an hour), and clears the record
-- once the catalog passes.
--
-- service_catalog_video_r2_retire_orphans ran its ready-copy loop in the
-- caller's transaction: one copy that could not be moved to 'retiring' (or
-- whose journal row could not be written) raised out of the function, rolled
-- back the whole pass and stopped the sweep that calls it, every minute. Each
-- copy now runs in its own subtransaction with the same record and backoff.
--
-- Both functions are redefined in full from the bodies 20261207195500 left;
-- the redefinition refuses to run over any other body.

do $base$
declare expected constant jsonb:=jsonb_build_object(
 'public.service_catalog_video_r2_reconcile_pending(integer)','8b5e0a8638d9d4a721b3612045dd3441',
 'public.service_catalog_video_r2_retire_orphans()','1ab236432d32c265eabe7fd706326b7b');
 fn text;
begin
 for fn in select jsonb_object_keys(expected) loop
  if (select md5(prosrc) from pg_catalog.pg_proc where oid=fn::regprocedure) is distinct from expected->>fn then
   raise exception 'VIDEO_R2_LOOP_BASE_CHANGED' using detail=fn;
  end if;
 end loop;
end $base$;

create or replace function public.service_catalog_video_r2_reconcile_pending(p_limit integer default 50) returns integer
language plpgsql security definer set search_path='' as $$
declare cat uuid; stale boolean; n integer:=0; outcome text;
begin
 if p_limit is null or p_limit not between 1 and 200 then raise exception 'INVALID_INPUT'; end if;
 for cat,stale in
  select pref.catalog_material_id,
   -- An R2 link whose copy is no longer ready: the catalog came back from the trash.
   (pref.enabled and exists(select 1 from private.catalog_video_publication_policies p
     join private.catalog_video_publication_jobs j on j.catalog_material_id=p.catalog_material_id and j.target_id=p.target_id and j.revision=p.revision and j.state='published'
     cross join lateral private.catalog_video_r2_cell_sources(j.id) cs
     where p.catalog_material_id=pref.catalog_material_id and cs.link_kind='r2'
      and not exists(select 1 from private.catalog_video_r2_copies c where c.team_id=pref.team_id and c.source_version=cs.source_version and c.state='ready'))) as stale
  from private.catalog_video_r2_preferences pref
  where exists(select 1 from private.catalog_video_publication_policies p where p.catalog_material_id=pref.catalog_material_id)
   and not private.settle_row_deferred('video_r2_reconcile',pref.catalog_material_id)
   and ((not pref.enabled and exists(select 1 from private.catalog_video_r2_uses u where u.catalog_material_id=pref.catalog_material_id))
    or (pref.enabled and exists(select 1 from private.catalog_video_publication_policies p
      join private.catalog_video_publication_jobs j on j.catalog_material_id=p.catalog_material_id and j.target_id=p.target_id and j.revision=p.revision and j.state='published'
      cross join lateral private.catalog_video_r2_cell_sources(j.id) cs
      where p.catalog_material_id=pref.catalog_material_id and (cs.link_kind<>'r2'
       or not exists(select 1 from private.catalog_video_r2_copies c where c.team_id=pref.team_id and c.source_version=cs.source_version and c.state='ready')))))
  order by pref.updated_at limit p_limit
 loop
  begin
   -- Plans only for a dead R2 link; anything else was planned when it was published.
   outcome:=private.catalog_video_r2_reconcile(cat,stale);
   if outcome='republished' then n:=n+1; end if;
   perform private.clear_settle_row_failure('video_r2_reconcile',cat);
  exception when others then
   perform private.note_settle_row_failure('video_r2_reconcile',cat,SQLSTATE,SQLERRM);
  end;
 end loop;
 return n;
end $$;
revoke all on function public.service_catalog_video_r2_reconcile_pending(integer) from public,anon,authenticated;
grant execute on function public.service_catalog_video_r2_reconcile_pending(integer) to service_role;

create or replace function public.service_catalog_video_r2_retire_orphans() returns integer language plpgsql security definer set search_path='' as $$
declare cfg private.catalog_video_r2_config%rowtype; n integer:=0; c record; released uuid[];
begin
 select * into cfg from private.catalog_video_r2_config where singleton;
 with gone as (
  delete from private.catalog_video_r2_uses u
   using public.team_materials m
   where m.id=u.catalog_material_id
    and ((m.lifecycle='missing' and m.missing_reason='removed')
     or m.lifecycle='trashed')
   returning u.copy_id)
 select coalesce(array_agg(distinct copy_id),'{}') into released from gone;
 -- Due now: the sweep that called this claims and deletes them right after.
 update private.catalog_video_r2_copies set retire_after=clock_timestamp()
  where id=any(released) and state='retiring'
   and not exists(select 1 from private.catalog_video_r2_uses u where u.copy_id=catalog_video_r2_copies.id);
 for c in select * from private.catalog_video_r2_copies where state='ready' and ready_at<clock_timestamp()-cfg.grace_interval and not exists(select 1 from private.catalog_video_r2_uses u where u.copy_id=catalog_video_r2_copies.id)
   and not private.settle_row_deferred('video_r2_retire_orphan',catalog_video_r2_copies.id) for update skip locked loop
  begin
   update private.catalog_video_r2_copies set state='retiring',retire_after=clock_timestamp()+cfg.grace_interval,retire_reason='replaced',fence=fence+1 where id=c.id;
   perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'retiring',null,null,null,c.size_bytes);
   perform private.clear_settle_row_failure('video_r2_retire_orphan',c.id);
   n:=n+1;
  exception when others then
   perform private.note_settle_row_failure('video_r2_retire_orphan',c.id,SQLSTATE,SQLERRM);
  end;
 end loop;
 return n;
end $$;
revoke all on function public.service_catalog_video_r2_retire_orphans() from public,anon,authenticated;
grant execute on function public.service_catalog_video_r2_retire_orphans() to service_role;
