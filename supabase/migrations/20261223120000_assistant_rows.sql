-- 064: the rows a card shows — named launches, or «my launches for a day» that were never sent to
-- generation — with the offer, ad account and creative names the card needs. At most 101 rows, so
-- a caller can tell «more than 100» without reading them all. Checked against the person's view
-- right in the space.

create function public.service_assistant_rows(p_user uuid, p_team uuid, p_ids uuid[], p_date date)
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
          'account', (select a.agent_id from public.team_account_agents a
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

revoke all on function public.service_assistant_rows(uuid, uuid, uuid[], date) from public, anon, authenticated;
grant execute on function public.service_assistant_rows(uuid, uuid, uuid[], date) to service_role;

-- A command of the caller (plan included) for continuing it after a button, without a model.
create function public.service_assistant_command(p_user uuid, p_command uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', c.id, 'teamId', c.team_id, 'status', c.status, 'kind', c.kind,
    'plan', c.plan, 'createdAt', c.created_at)
  from private.assistant_commands c
  where c.id = p_command and c.user_id = p_user and private.can(c.team_id, 'edit', p_user);
$$;

revoke all on function public.service_assistant_command(uuid, uuid) from public, anon, authenticated;
grant execute on function public.service_assistant_command(uuid, uuid) to service_role;
