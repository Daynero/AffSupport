-- A non-member has a NULL team_role; NOT IN then evaluates to NULL and the
-- old guard did not deny a security-definer read of contribution aggregates.
create or replace function public.list_library_contribution_totals(
  p_team uuid,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (category text, action_kind text, outcome text, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not coalesce(private.team_role(p_team, auth.uid()) in ('owner', 'admin'), false) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if (p_from is null) <> (p_to is null) or (p_from is not null and p_from >= p_to) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  select record.category, record.action_kind, record.outcome, count(*)
  from public.team_contribution_records as record
  where record.team_id = p_team
    and (p_from is null or (record.occurred_at >= p_from and record.occurred_at < p_to))
  group by record.category, record.action_kind, record.outcome
  order by record.category, record.action_kind, record.outcome;
end;
$$;
