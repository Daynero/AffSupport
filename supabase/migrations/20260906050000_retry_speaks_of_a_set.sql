-- Retry, like the scan and the claim, is about a set.
--
-- `retry_failed_library_jobs` was the last function in this family still taking
-- one material, so the window's "retry the failed ones" over a chosen set of
-- four hundred fired four hundred round trips from one press. The scope is the
-- same array the other two already take.

drop function if exists public.retry_failed_library_jobs(uuid, uuid);

create or replace function public.retry_failed_library_jobs(
  p_team uuid,
  p_sources uuid[] default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  scope uuid[] := nullif(p_sources, '{}');
  retried integer;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if scope is not null and cardinality(scope) > 500 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_library_requirements as requirement
     set state = 'pending', last_error_code = null
   where requirement.team_id = p_team and requirement.state = 'failed'
     and (scope is null or requirement.source_material_id = any(scope));
  get diagnostics retried = row_count;
  return retried;
end;
$$;

grant execute on function public.retry_failed_library_jobs(uuid, uuid[])
to authenticated;
