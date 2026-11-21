-- 064: a card names an ad account the way the launch list does — «g4-257», the account name and
-- the last three digits of the ad account — not the bare provider id.

create or replace function public.service_assistant_rows(p_user uuid, p_team uuid, p_ids uuid[], p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_user is null or p_team is null or not private.can(p_team, 'view', p_user) then
    raise exception 'PERMISSION_DENIED' using errcode = 'PT409';
  end if;
  if (p_ids is null) = (p_date is null) or coalesce(cardinality(p_ids), 0) > 101 then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  return coalesce((
    select jsonb_agg(row_json order by ord)
    from (
      select
        coalesce(array_position(p_ids, l.id), 0) * 1000000000::bigint
          + extract(epoch from l.created_at)::bigint as ord,
        jsonb_build_object(
          'id', l.id,
          'version', l.aggregate_version::text,
          'config', l.draft_config,
          'launchDate', l.effective_launch_date,
          'createdBy', l.created_by,
          'createdVia', l.created_via,
          'offer', (select o.name from public.team_launch_offers o
                    where o.team_id = l.team_id and o.id::text = l.draft_config ->> 'offerId'),
          'account', (select case when coalesce(btrim(ac.name), '') = '' then a.agent_id
                                  else btrim(ac.name) || '-' || right(a.agent_id, 3) end
                      from public.team_account_agents a
                      left join public.team_accounts ac on ac.id = a.account_id
                      where a.team_id = l.team_id and a.id::text = l.draft_config ->> 'agentRowId'),
          'materials', coalesce((
            select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name))
            from public.team_materials m
            where m.team_id = l.team_id
              and m.id::text in (
                select c ->> 'materialId' from jsonb_array_elements(
                  case when jsonb_typeof(l.draft_config -> 'creatives') = 'array'
                       then l.draft_config -> 'creatives' else '[]'::jsonb end) c
                union select l.draft_config ->> 'materialId'
              )
          ), '[]'::jsonb),
          'generationState', (select g.state from public.team_launch_generations g
                              where g.launch_id = l.id order by g.created_at desc limit 1)
        ) as row_json
      from public.team_launches l
      where l.team_id = p_team
        and l.archived_at is null
        and (
          (p_ids is not null and l.id = any (p_ids))
          or (
            p_date is not null
            and l.effective_launch_date = p_date
            and l.created_by = p_user
            and not exists (
              select 1 from public.team_launch_generations g
              where g.launch_id = l.id and g.state not in ('failed', 'canceled')
            )
          )
        )
      order by 1
      limit 101
    ) rows
  ), '[]'::jsonb);
end;
$$;
