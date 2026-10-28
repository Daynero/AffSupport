-- Owner-selected allowance: 500 unique images and decimal 100 MB (0.1 GB).
-- ~200 KB/image is a planning estimate, never a lossy target or per-file cap.
-- Applied 1570/1580 remain immutable. Existing charges are not rewritten or
-- deleted; existing over-limit data and exact dedup continue to work.
-- migration up --local executes this file without the db-test runner's implicit
-- transaction. Keep the lock, all DDL and invalidation in one explicit unit.
begin;
-- Drain publication writes before replacing admission, so a previously running
-- old trigger cannot admit new growth under the old ceiling after this commits.
-- DELETE/owner transfer takes teams before touching signal rows/publications.
-- Drain those writers first, rather than holding publications while waiting on
-- a signal row held by a team deletion that is itself waiting on publications.
lock table public.teams in share row exclusive mode;
lock table private.catalog_image_publications in share row exclusive mode;

do $migration$
declare definition text; patch record;
begin
 definition:=pg_get_functiondef('private.catalog_image_storage_charge()'::regprocedure);
 if (length(definition)-length(replace(definition,'if used+new.size_bytes>1000000000 or images>=5000 then','')))<>length('if used+new.size_bytes>1000000000 or images>=5000 then') then
  raise exception '045 quota amendment expected the known admission limit';
 end if;
 definition:=replace(definition,'if used+new.size_bytes>1000000000 or images>=5000 then','if used+new.size_bytes>100000000 or images>=500 then');
 execute definition;

 definition:=pg_get_functiondef('public.service_catalog_image_control_v2(text,uuid,jsonb)'::regprocedure);
 for patch in select * from (values
  ($old$jsonb_build_object('limitBytes',1000000000,'limitImages',5000$old$,$new$jsonb_build_object('limitBytes',100000000,'limitImages',500$new$),
  ($old$greatest(0,1000000000-used)$old$,$new$greatest(0,100000000-used)$new$)
 ) patches(old_source,new_source) loop
  if (length(definition)-length(replace(definition,patch.old_source,'')))<>length(patch.old_source) then
   raise exception '045 quota amendment expected the known storage response limit';
  end if;
  definition:=replace(definition,patch.old_source,patch.new_source);
 end loop;
 execute definition;
end $migration$;

-- Keep the diagnostic view's shape and read-only ACL; it must report precisely
-- the same physical allowance as admission and the product's storage response.
create or replace view public.analytics_catalog_image_storage with(security_invoker=false) as
 with totals as (
  select s.owner_scope,sum(s.size_bytes)::bigint used_bytes,count(*)::bigint images,
   coalesce(sum(s.size_bytes) filter(where q.reason in ('explicit_revoke','team_deleted')),0)::bigint pending_deletion_bytes,
   coalesce(sum(s.size_bytes) filter(where coalesce(q.reason,'') not in ('explicit_revoke','team_deleted') and p.state in ('candidate','put_unknown','origin_verified','public_verified')),0)::bigint reserved_bytes,
   coalesce(sum(s.size_bytes) filter(where p.state='ready' and e.active and coalesce(q.reason,'') not in ('explicit_revoke','team_deleted')),0)::bigint library_bytes
  from private.catalog_image_storage s
  left join private.catalog_image_publications p on p.id=s.publication_id
  left join public.team_catalog_image_pool_entries e on e.publication_id=s.publication_id
  left join private.catalog_image_purges q on q.bucket_kind='public' and q.object_key=s.object_key
  where s.charged group by s.owner_scope
 )
 select t.id team_id,t.owner_id account_id,100000000::bigint limit_bytes,500::bigint limit_images,
  coalesce(z.used_bytes,0)::bigint used_bytes,coalesce(z.images,0)::bigint images,
  coalesce(z.pending_deletion_bytes,0)::bigint pending_deletion_bytes,
  coalesce(z.reserved_bytes,0)::bigint reserved_bytes,coalesce(z.library_bytes,0)::bigint library_bytes,
  (coalesce(z.used_bytes,0)-coalesce(z.pending_deletion_bytes,0)-coalesce(z.reserved_bytes,0)-coalesce(z.library_bytes,0))::bigint retained_bytes,
  greatest(0,100000000-coalesce(z.used_bytes,0))::bigint available_bytes
 from public.teams t left join totals z on z.owner_scope=t.owner_id;

-- The transaction publishes new limits and their existing-channel invalidation
-- atomically. No FK/team-row locks or append-only events are introduced.
insert into public.team_catalog_image_storage_signals(team_id)
 select id from public.teams order by id
on conflict(team_id) do update set revision=team_catalog_image_storage_signals.revision+1,updated_at=clock_timestamp();

revoke all on function private.catalog_image_storage_charge() from public,anon,authenticated,service_role;
revoke all on function public.service_catalog_image_control_v2(text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.service_catalog_image_control_v2(text,uuid,jsonb) to service_role;
revoke all on public.analytics_catalog_image_storage from public,anon,authenticated,service_role;
commit;
