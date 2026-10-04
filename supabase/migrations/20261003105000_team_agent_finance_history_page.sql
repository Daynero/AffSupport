-- Page transfers and money together; never load an agent's entire transfer archive.
create or replace function public.list_team_agent_finance_history(p_team uuid,p_agent uuid,p_cursor jsonb default null,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare page jsonb;begin
  perform private.finance_access(p_team,'view');
  if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  with entries as (
    select e.occurred_at,e.id,'finance'::text as kind,
      (to_jsonb(e)-'old_cents'-'new_cents'-'previous_version'-'new_version')||jsonb_build_object(
        'oldValue',case when e.old_cents is null then null else to_char(e.old_cents::numeric/100,'FM9999999990.00') end,
        'newValue',case when e.new_cents is null then null else to_char(e.new_cents::numeric/100,'FM9999999990.00') end,
        'previous_version',e.previous_version::text,'new_version',e.new_version::text,
        'account_name',a.name,'actor_name',p.display_name) as value
    from public.team_agent_finance_events e join public.team_accounts a on a.id=e.account_id
      left join public.profiles p on p.id=e.actor_id
    where e.team_id=p_team and e.agent_row_id=p_agent
    union all
    select e.occurred_at,e.id,'transfer'::text,
      to_jsonb(e)||jsonb_build_object('from_account',a.name,'to_account',b.name,'actor_name',p.display_name)
    from public.team_agent_transfer_events e
      join public.team_agent_placements f on f.id=e.from_placement_id
      join public.team_agent_placements t on t.id=e.to_placement_id
      join public.team_accounts a on a.id=f.account_id join public.team_accounts b on b.id=t.account_id
      left join public.profiles p on p.id=e.actor_id
    where e.team_id=p_team and e.agent_row_id=p_agent
  ), limited as (
    select * from entries where p_cursor is null or (occurred_at,id)<((p_cursor->>'time')::timestamptz,(p_cursor->>'id')::uuid)
    order by occurred_at desc,id desc limit p_limit
  ) select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'value',value,'time',occurred_at,'id',id) order by occurred_at desc,id desc),'[]') into page from limited;
  return jsonb_build_object(
    'events',coalesce((select jsonb_agg(v->'value' order by ord) from jsonb_array_elements(page) with ordinality x(v,ord) where v->>'kind'='finance'),'[]'),
    'transfers',coalesce((select jsonb_agg(v->'value' order by ord) from jsonb_array_elements(page) with ordinality x(v,ord) where v->>'kind'='transfer'),'[]'),
    'nextCursor',case when jsonb_array_length(page)=p_limit then jsonb_build_object('time',page->-1->>'time','id',page->-1->>'id') else null end);
end $$;
