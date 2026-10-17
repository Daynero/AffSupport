-- Card metadata for creation date and account chip.
-- Metadata-only readiness and social search, still filtered before pagination.
-- Compact cards use allowed metadata only, without URL or SUB values.
create or replace function public.list_launches(p_team uuid,p_filter jsonb default '{}',p_limit integer default 50) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.launch_access(p_team,'view');if p_limit not between 1 and 100 or jsonb_typeof(p_filter)<>'object' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select coalesce(jsonb_agg(summary order by launch_date desc nulls last,id desc),'[]') into result from (
 select l.id,l.effective_launch_date launch_date,jsonb_build_object('id',l.id,'version',l.aggregate_version::text,'createdAt',l.created_at,'launchDate',l.effective_launch_date,
 'offer',coalesce(r.sources->>'offer',o.name,''),'social',coalesce(r.sources->>'social',a.name,''),'creativeAlias',coalesce(r.config->>'creativeAlias',l.draft_config->>'creativeAlias',''),
 'method',coalesce(r.config->>'method',l.draft_config->>'method','other'),'workStatus',l.work_status,'assigneeId',l.assignee_id,
 'agentSuffix',right(coalesce(r.sources->>'agentId',ag.agent_id,''),3),'agentId',coalesce(r.sources->>'agentId',ag.agent_id,''),'accountName',coalesce(r.sources->>'social',a.name,''),'agentFree',not exists(select 1 from public.team_agent_runs ar where ar.agent_row_id=ag.id),'assigneeLabel',l.assignee_label_snapshot,'gender',case when coalesce(r.config->>'gender',l.draft_config->>'gender') in('M','W','ALL') then coalesce(r.config->>'gender',l.draft_config->>'gender') else null end,'age',case when coalesce(r.config->>'age',l.draft_config->>'age') ~ '^[1-9][0-9]{0,15}$' then coalesce(r.config->>'age',l.draft_config->>'age')::numeric else null end,'campaignCount',case when coalesce(r.config->>'campaignCount',l.draft_config->>'campaignCount') ~ '^[1-9][0-9]{0,2}$' then coalesce(r.config->>'campaignCount',l.draft_config->>'campaignCount')::integer else 0 end,'advantagePlus',coalesce(r.config->'advantagePlus',l.draft_config->'advantagePlus')='true'::jsonb,
 'hasResult',l.active_revision_id is not null,'budgets',coalesce((select jsonb_agg(coalesce(r.result_overrides->'campaigns'->(c.ordinal::text)->>'budget',c.budget_usd::text)::numeric order by c.ordinal) from public.team_launch_campaigns c where c.revision_id=coalesce(r.baseline_revision_id,r.id)),'[]'),
 'generationState',(select g.state from public.team_launch_generations g where g.launch_id=l.id order by g.created_at desc,g.id desc limit 1)) summary
 from public.team_launches l left join public.team_launch_revisions r on r.id=l.active_revision_id
 left join public.team_launch_offers o on o.id=nullif(l.draft_config->>'offerId','')::uuid and o.team_id=l.team_id
 left join public.team_account_agents ag on ag.id=nullif(l.draft_config->>'agentRowId','')::uuid and ag.team_id=l.team_id left join public.team_accounts a on a.id=ag.account_id
 where l.team_id=p_team and l.archived_at is null
 and (nullif(p_filter->>'status','') is null or l.work_status=p_filter->>'status')
 and (nullif(p_filter->>'assigneeId','') is null or l.assignee_id=(p_filter->>'assigneeId')::uuid)
 and (nullif(p_filter->>'from','') is null or l.effective_launch_date>=(p_filter->>'from')::date)
 and (nullif(p_filter->>'to','') is null or l.effective_launch_date<=(p_filter->>'to')::date)
 and (nullif(p_filter->>'cursorId','') is null or (coalesce(l.effective_launch_date,'0001-01-01'::date),l.id)<(coalesce((p_filter->>'cursorDate')::date,'0001-01-01'::date),(p_filter->>'cursorId')::uuid))
 and (nullif(p_filter->>'search','') is null or position(lower(p_filter->>'search') in lower(coalesce(r.sources->>'offer',o.name,'')||' '||coalesce(r.sources->>'social',a.name,'')||' '||coalesce(r.config->>'creativeAlias',l.draft_config->>'creativeAlias',''))) > 0)
 order by l.effective_launch_date desc nulls last,l.id desc limit p_limit
 ) page;
 return jsonb_build_object('items',result,'nextCursor',case when jsonb_array_length(result)=p_limit then jsonb_build_object('id',result->(p_limit-1)->>'id','date',result->(p_limit-1)->>'launchDate') else null end);
end $$;
