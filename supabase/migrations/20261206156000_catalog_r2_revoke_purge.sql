-- Repair live PostgreSQL's PL/pgSQL row-variable/SQL-alias collision without
-- rewriting the applied foundation or changing its authorization/receipt gates.
-- Promote durable orphan cleanup to explicit deletion: every successful publish
-- already owns the same unique (bucket_kind, object_key) purge row.
do $migration$
declare definition text; patch record;
begin
 definition:=pg_get_functiondef('private.catalog_image_control_impl_v2(text,uuid,jsonb)'::regprocedure);
 for patch in select * from (values
  ($old$now_at timestamptz:=clock_timestamp();$old$,
   $new$v_revoke_uncertain boolean; now_at timestamptz:=clock_timestamp();$new$),
  ($old$perform 1 from private.catalog_image_publications p where p.id=(p_payload->>'publicationId')::uuid and p.team_id=t and exists(select 1 from public.team_catalog_image_pool_entries e where e.publication_id=p.id and e.revision=(p_payload->>'revision')::bigint) for update;$old$,
   $new$-- Cleanup workers lock purge then publication; use the same order here.
   perform 1 from private.catalog_image_purges purge where purge.bucket_kind='public' and purge.publication_id=(p_payload->>'publicationId')::uuid for update;
   select p.uncertain_write or p.state='put_unknown' into v_revoke_uncertain from private.catalog_image_publications p where p.id=(p_payload->>'publicationId')::uuid and p.team_id=t and exists(select 1 from public.team_catalog_image_pool_entries pool_entry where pool_entry.publication_id=p.id and pool_entry.revision=(p_payload->>'revision')::bigint) for update;$new$),
  ($old$insert into private.catalog_image_purges(publication_id,scope_id,bucket_kind,object_key,reason) select id,team_id,'public',object_key,'explicit_revoke' from private.catalog_image_publications where id=(p_payload->>'publicationId')::uuid on conflict(bucket_kind,object_key) do nothing;$old$,
   $new$insert into private.catalog_image_purges(publication_id,scope_id,bucket_kind,object_key,reason,uncertain_write) select id,team_id,'public',object_key,'explicit_revoke',v_revoke_uncertain from private.catalog_image_publications where id=(p_payload->>'publicationId')::uuid
   on conflict(bucket_kind,object_key) do update set
    reason='explicit_revoke',state='pending',fence=catalog_image_purges.fence+1,
    lease_until=null,attempts=0,next_attempt_at=clock_timestamp(),
    uncertain_write=catalog_image_purges.uncertain_write or excluded.uncertain_write,
    not_before=greatest(clock_timestamp(),case when catalog_image_purges.reason in ('explicit_revoke','team_deleted') then catalog_image_purges.not_before else '-infinity'::timestamptz end);$new$)
 ) patches(old_source,new_source) loop
  if (length(definition)-length(replace(definition,patch.old_source,'')))<>length(patch.old_source) then
   raise exception '045 revoke migration expected exactly one known source fragment';
  end if;
  definition:=replace(definition,patch.old_source,patch.new_source);
 end loop;
 execute definition;

 definition:=pg_get_functiondef('private.catalog_image_before_team_delete()'::regprocedure);
 if strpos(definition,$old$on conflict(bucket_kind,object_key) do update set reason='team_deleted',uncertain_write=catalog_image_purges.uncertain_write or excluded.uncertain_write;$old$)=0 then
  raise exception '045 team deletion migration expected the known purge upsert';
 end if;
 definition:=replace(definition,
  $old$on conflict(bucket_kind,object_key) do update set reason='team_deleted',uncertain_write=catalog_image_purges.uncertain_write or excluded.uncertain_write;$old$,
  $new$on conflict(bucket_kind,object_key) do update set
   reason='team_deleted',state='pending',fence=catalog_image_purges.fence+1,
   lease_until=null,attempts=0,next_attempt_at=clock_timestamp(),
   uncertain_write=catalog_image_purges.uncertain_write or excluded.uncertain_write,
   not_before=greatest(excluded.not_before,case when catalog_image_purges.reason in ('explicit_revoke','team_deleted') then catalog_image_purges.not_before else '-infinity'::timestamptz end);$new$);
 execute definition;
end $migration$;

-- CREATE OR REPLACE preserves identity, SECURITY DEFINER, search_path and ACLs;
-- keep the private implementation and trigger unavailable as service bypasses.
revoke all on function private.catalog_image_control_impl_v2(text,uuid,jsonb)
 from public,anon,authenticated,service_role;
revoke all on function private.catalog_image_before_team_delete()
 from public,anon,authenticated,service_role;
