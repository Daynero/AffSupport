-- Correlated, content-free normalization and authoritative account storage evidence.
create function public.service_catalog_image_optimization_v2(p_entry uuid,p_worker text,p_fence bigint,p_phase text)
returns void language plpgsql security definer set search_path='' as $$
declare entry private.catalog_image_import_entries%rowtype;
begin
 if p_phase not in ('started','completed') then raise exception 'INVALID_INPUT'; end if;
 if not public.service_catalog_image_renew_v2(p_entry,p_worker,p_fence) then raise exception 'LEASE_MISMATCH'; end if;
 select * into entry from private.catalog_image_import_entries where id=p_entry and state='validating' and fence=p_fence and lease_owner=p_worker;
 if not found then raise exception 'WRONG_STATE'; end if;
 insert into private.catalog_image_journal(team_id,job_id,entry_id,stage)
 values(entry.team_id,entry.job_id,entry.id,case when p_phase='started' then 'optimizing' else 'optimized' end);
end $$;
revoke all on function public.service_catalog_image_optimization_v2(uuid,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.service_catalog_image_optimization_v2(uuid,text,bigint,text) to service_role;

do $$ declare definition text; fragment text:=$old$'validating'::text$old$;
begin
 definition:=pg_get_viewdef('public.analytics_catalog_image_journal'::regclass,true);
 if (length(definition)-length(replace(definition,fragment,'')))<>length(fragment) then raise exception '045 optimization expected one known diagnostic stage fragment'; end if;
 definition:=replace(definition,fragment,$new$'validating'::text, 'optimizing'::text, 'optimized'::text$new$);
 execute 'create or replace view public.analytics_catalog_image_journal with(security_invoker=false) as '||definition;
end $$;

create view public.analytics_catalog_image_optimization with(security_invoker=false) as
 select e.id entry_id,e.team_id,e.job_id,e.source_size source_bytes,e.canonical_size canonical_bytes,
  e.canonical_mime,e.optimization_version,e.state,e.error_code
 from private.catalog_image_import_entries e;

-- One row per current workspace, repeating its owner's single aggregate budget.
-- No filenames, paths, URLs, provider payloads or source/canonical hashes.
create view public.analytics_catalog_image_storage with(security_invoker=false) as
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
 select t.id team_id,t.owner_id account_id,1000000000::bigint limit_bytes,5000::bigint limit_images,
  coalesce(z.used_bytes,0)::bigint used_bytes,coalesce(z.images,0)::bigint images,
  coalesce(z.pending_deletion_bytes,0)::bigint pending_deletion_bytes,
  coalesce(z.reserved_bytes,0)::bigint reserved_bytes,coalesce(z.library_bytes,0)::bigint library_bytes,
  (coalesce(z.used_bytes,0)-coalesce(z.pending_deletion_bytes,0)-coalesce(z.reserved_bytes,0)-coalesce(z.library_bytes,0))::bigint retained_bytes,
  greatest(0,1000000000-coalesce(z.used_bytes,0))::bigint available_bytes
 from public.teams t left join totals z on z.owner_scope=t.owner_id;
revoke all on public.analytics_catalog_image_optimization,public.analytics_catalog_image_storage from public,anon,authenticated,service_role;
do $$ begin
 if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
  grant select on public.analytics_catalog_image_optimization,public.analytics_catalog_image_storage to wishly_analytics_ro;
 end if;
end $$;
