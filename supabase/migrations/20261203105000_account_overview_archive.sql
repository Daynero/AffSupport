-- Include archived socials alongside their historical launch and placement identities.
begin;
create or replace function public.get_team_account_launch_finance_overview(
  p_team uuid, p_from date, p_to date
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366 then
    raise exception 'INVALID_PERIOD' using errcode = '22023';
  end if;

  with social_rows as (
    select a.id, a.name, a.sort_rank, a.archived_at from public.team_accounts a
    where a.team_id = p_team
  ), agent_rows as (
    select a.id, a.account_id, a.agent_id, a.sort_rank
    from public.team_account_agents a where a.team_id = p_team
  ), launch_rows as (
    select l.id, l.effective_launch_date, l.work_status, l.archived_at,
      coalesce(nullif(r.sources->>'agentRowId', ''), nullif(r.config->>'agentRowId', ''),
        nullif(l.draft_config->>'agentRowId', '')) as agent_row_text,
      coalesce(nullif(r.sources->>'accountId', ''),
        nullif(l.expected_source_snapshot->>'accountId', '')) as snapshot_social_text,
      coalesce(r.sources->>'offer', l.draft_config->>'offer', '') as offer,
      coalesce(r.config->>'creativeAlias', l.draft_config->>'creativeAlias', '') as creative_alias
    from public.team_launches l
    left join public.team_launch_revisions r on r.id = l.active_revision_id and r.team_id = l.team_id
    where l.team_id = p_team
  ), linked_launches as (
    select l.*, a.id as live_agent_id, a.account_id as current_social_id,
      s.id as snapshot_social_id
    from launch_rows l
    left join agent_rows a on a.id::text = l.agent_row_text
    left join social_rows s on s.id::text = l.snapshot_social_text
  ), finance_rows as (
    select p.id as placement_id, p.agent_row_id, p.account_id, p.starts_on, p.ends_on,
      (select v.amount_cents from public.team_agent_finance_values v
        where v.team_id = p_team and v.placement_id = p.id and v.metric = 'balance'
          and v.entry_date between p_from and p_to
        order by v.entry_date desc, v.id desc limit 1) as balance_cents,
      (select sum(v.amount_cents) from public.team_agent_finance_values v
        where v.team_id = p_team and v.placement_id = p.id and v.metric = 'topup'
          and v.entry_date between p_from and p_to) as topup_cents,
      (select sum(v.amount_cents) from public.team_agent_finance_values v
        where v.team_id = p_team and v.placement_id = p.id and v.metric = 'spend'
          and v.entry_date between p_from and p_to) as spend_cents
    from public.team_agent_placements p
    where p.team_id = p_team and p.starts_on <= p_to
      and (p.ends_on is null or p.ends_on > p_from)
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'currency', 'USD'),
    'socials', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'sortRank', sort_rank, 'archivedAt', archived_at) order by sort_rank, id)
      from social_rows), '[]'::jsonb),
    'agents', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'socialId', account_id, 'agentId', agent_id, 'sortRank', sort_rank)
      order by account_id, sort_rank, id) from agent_rows), '[]'::jsonb),
    'launches', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id,
      'agentRowId', case when agent_row_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then agent_row_text else null end,
      'snapshotSocialId', case when snapshot_social_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then snapshot_social_text else null end,
      'currentSocialId', current_social_id,
      'association', case
        when snapshot_social_id is null then 'unmatched'
        when live_agent_id is null then 'unmatched'
        when snapshot_social_id is not null and snapshot_social_id <> current_social_id then 'moved'
        else 'matched' end,
      'unmatchedReason', case
        when snapshot_social_id is null then 'missing_snapshot_social'
        when live_agent_id is null then 'missing_agent' else null end,
      'launchDate', effective_launch_date, 'workStatus', work_status,
      'archived', archived_at is not null, 'offer', offer, 'creativeAlias', creative_alias)
      order by effective_launch_date desc nulls last, id desc) from linked_launches), '[]'::jsonb),
    'finance', coalesce((select jsonb_agg(jsonb_build_object(
      'placementId', placement_id, 'agentRowId', agent_row_id, 'socialId', account_id,
      'startsOn', starts_on, 'endsOn', ends_on,
      'balanceCents', balance_cents, 'topupCents', topup_cents, 'spendCents', spend_cents)
      order by account_id, agent_row_id, starts_on, placement_id)
      from finance_rows), '[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.get_team_account_launch_finance_overview(uuid,date,date)
  from public, anon;
grant execute on function public.get_team_account_launch_finance_overview(uuid,date,date)
  to authenticated;

commit;
