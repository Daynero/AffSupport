-- Keep the original tenant key. Remove the duplicate only if no FK owns it.
-- Never cascade; both constraints enforce the same uniqueness before this change.
do $$
declare
  kept oid;
  redundant oid;
begin
  select conindid into kept from pg_constraint
    where conrelid = to_regclass('public.team_account_agents')
      and conname = 'team_account_agents_id_team_unique' and contype = 'u';
  select conindid into redundant from pg_constraint
    where conrelid = to_regclass('public.team_account_agents')
      and conname = 'team_agents_tenant_key' and contype = 'u';
  if kept is null or redundant is null then return; end if;
  if not exists (
    select 1 from pg_index a join pg_index b on b.indexrelid = redundant
    where a.indexrelid = kept and a.indisvalid and b.indisvalid
      and a.indisunique and b.indisunique and a.indkey = b.indkey
      and a.indclass = b.indclass and a.indcollation = b.indcollation
      and a.indoption = b.indoption and a.indexprs is null and b.indexprs is null
      and a.indpred is null and b.indpred is null
  ) then raise exception 'TENANT_INDEX_DEFINITIONS_DIFFER'; end if;
  if exists (select 1 from pg_constraint where contype = 'f' and conindid = redundant) then
    raise notice 'Tenant duplicate retained: a foreign key depends on it';
    return;
  end if;
  alter table public.team_account_agents drop constraint team_agents_tenant_key;
end;
$$;
