create function private.launch_access(p_team uuid,p_permission text) returns void language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.can(p_team,p_permission,auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
end $$;
create function private.launch_request(p_team uuid,p_key text,p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.team_launch_requests%rowtype;d text;
begin
 if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,200}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text||auth.uid()::text||p_key,0));
 d:=encode(extensions.digest(p_action||p_payload::text,'sha256'),'hex');
 select * into r from public.team_launch_requests where team_id=p_team and actor_id=auth.uid() and request_key=p_key;
 if found then if r.action<>p_action or r.digest<>d then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;return r.result;end if;
 return null;
end $$;
create function private.launch_remember(p_team uuid,p_key text,p_action text,p_payload jsonb,p_result jsonb) returns void language sql security definer set search_path='' as $$
 insert into public.team_launch_requests(team_id,actor_id,request_key,action,digest,result) values(p_team,auth.uid(),p_key,p_action,encode(extensions.digest(p_action||p_payload::text,'sha256'),'hex'),p_result);
$$;
create function private.launch_unlocked(p_team uuid,p_launch uuid) returns void language plpgsql stable security definer set search_path='' as $$
begin
 if exists(select 1 from public.team_launch_generations where team_id=p_team and launch_id=p_launch and state in('accepted','running','waiting_dependency','cancel_requested','canceled_with_cleanup_pending')) then raise exception 'LAUNCH_BUSY' using errcode='55000';end if;
end $$;
create function private.launch_signal(p_team uuid,p_launch uuid,p_version bigint) returns void language sql security definer set search_path='' as $$
 insert into public.team_launch_signals(launch_id,team_id,version) values(p_launch,p_team,p_version) on conflict(launch_id) do update set version=excluded.version,updated_at=clock_timestamp();
$$;
create function public.list_launch_dictionaries(p_team uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform private.launch_access(p_team,'view');
 return jsonb_build_object('offers',coalesce((select jsonb_agg(jsonb_build_object('id',id,'value',name,'updatedAt',updated_at) order by name) from public.team_launch_offers where team_id=p_team and archived_at is null),'[]'),
 'buyers',coalesce((select jsonb_agg(jsonb_build_object('id',id,'value',value,'updatedAt',updated_at) order by value) from public.team_launch_buyers where team_id=p_team and archived_at is null),'[]'));
end $$;
create function public.create_launch_dictionary(p_team uuid,p_kind text,p_value text,p_request_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v text;k text;payload jsonb:=jsonb_build_array(p_kind,p_value);replay jsonb;result jsonb;
begin
 perform private.launch_access(p_team,'manage_metadata');replay:=private.launch_request(p_team,p_request_key,'dictionary-create',payload);if replay is not null then return replay;end if;
 v:=normalize(btrim(p_value),NFC);
 if p_kind='buyers' then v:=regexp_replace(v,'[[:blank:]]+','_','g');if char_length(v) not between 1 and 80 or v !~ '^[A-Za-z0-9_-]+$' then raise exception 'LAUNCH_SUB_INVALID' using errcode='22023';end if;
 elsif p_kind='offers' then if char_length(v) not between 1 and 160 or v ~ '[[:cntrl:]]' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 else raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if v is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;k:=lower(v);
 if p_kind='buyers' then
 insert into public.team_launch_buyers(team_id,value,normalized_key,created_by) values(p_team,v,k,auth.uid()) on conflict(team_id,normalized_key) do update set archived_at=null returning jsonb_build_object('id',id,'value',value,'updatedAt',updated_at) into result;
 else
 insert into public.team_launch_offers(team_id,name,normalized_key,created_by) values(p_team,v,k,auth.uid()) on conflict(team_id,normalized_key) do update set archived_at=null returning jsonb_build_object('id',id,'value',name,'updatedAt',updated_at) into result;
 end if;
 perform private.launch_remember(p_team,p_request_key,'dictionary-create',payload,result);return result;
end $$;
create function public.save_launch_draft(p_team uuid,p_launch uuid,p_expected_version text,p_request_key text,p_config jsonb,p_expected_sources jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.team_launches%rowtype;payload jsonb:=jsonb_build_array(p_launch,p_expected_version,p_config,p_expected_sources);replay jsonb;result jsonb;d date;
begin
 perform private.launch_access(p_team,'edit');replay:=private.launch_request(p_team,p_request_key,'draft-save',payload);if replay is not null then return replay;end if;
 if p_config is null or jsonb_typeof(p_config)<>'object' or octet_length(p_config::text)>65536 or (p_expected_sources is not null and (jsonb_typeof(p_expected_sources)<>'object' or octet_length(p_expected_sources::text)>16384)) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if p_config ? 'originalUrl' and (jsonb_typeof(p_config->'originalUrl')<>'string' or char_length(p_config->>'originalUrl')>8192) then raise exception 'LAUNCH_URL_INVALID' using errcode='22023';end if;
 for result in select to_jsonb(k) from unnest(array['agentRowId','offerId','buyerId','materialId']) k loop
  if nullif(p_config->>(result #>> '{}'),'') is not null and (p_config->>(result #>> '{}')) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 if nullif(p_config->>'launchDate','') is not null then d:=(p_config->>'launchDate')::date;end if;
 if p_launch is null then
  insert into public.team_launches(team_id,created_by,draft_config,expected_source_snapshot,effective_launch_date) values(p_team,auth.uid(),p_config,p_expected_sources,d) returning * into r;
 else
  select * into r from public.team_launches where id=p_launch and team_id=p_team and archived_at is null for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
  perform private.launch_unlocked(p_team,p_launch);
  if p_expected_version is null or r.aggregate_version::text<>p_expected_version then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
  update public.team_launches set draft_config=p_config,expected_source_snapshot=p_expected_sources,draft_version=draft_version+1,aggregate_version=aggregate_version+1,effective_launch_date=case when active_revision_id is null then d else effective_launch_date end,updated_at=clock_timestamp() where id=p_launch returning * into r;
 end if;
 result:=jsonb_build_object('id',r.id,'version',r.aggregate_version::text);
 perform private.launch_signal(p_team,r.id,r.aggregate_version);perform private.launch_remember(p_team,p_request_key,'draft-save',payload,result);return result;
end $$;
create function private.launch_revision_json(p_team uuid,p_revision uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',r.id,'revisionNo',r.revision_no,'kind',r.result_kind,'config',r.config,'sources',r.sources,'baselineRevisionId',r.baseline_revision_id,
 'baseline',jsonb_build_object('advertisingUrl',b.generated_url,'subValues',b.sub_values,'campaigns',coalesce((select jsonb_agg(jsonb_build_object('ordinal',c.ordinal,'budget',c.budget_usd,'adStart',c.ad_start,'adEnd',c.ad_end,'name',c.name) order by c.ordinal) from public.team_launch_campaigns c where c.revision_id=b.id),'[]')),
 'overrides',r.result_overrides,'catalog',(select jsonb_build_object('id',x.catalog_id,'materialId',x.material_id,'variant',x.variant,'name',x.name_snapshot,'url',x.sheet_url,'restitchMaterialId',x.restitch_material_id) from public.team_launch_revision_catalogs x where x.revision_id=r.id),'createdAt',r.created_at)
 from public.team_launch_revisions r join public.team_launch_revisions b on b.id=coalesce(r.baseline_revision_id,r.id) where r.team_id=p_team and r.id=p_revision;
$$;
create function public.get_launch(p_team uuid,p_launch uuid,p_revision uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.team_launches%rowtype;g jsonb;
begin
 perform private.launch_access(p_team,'view');select * into r from public.team_launches where team_id=p_team and id=p_launch;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if p_revision is not null and not exists(select 1 from public.team_launch_revisions where id=p_revision and launch_id=p_launch and team_id=p_team) then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select jsonb_build_object('id',id,'state',state,'stage',stage,'stateVersion',state_version::text,'progress',progress,'errorCode',safe_error_code,'childOperationIds',coalesce((select jsonb_agg(s.team_operation_id) from public.team_launch_generation_steps s where s.generation_id=generation.id and s.team_operation_id is not null),'[]')) into g from public.team_launch_generations generation where generation.launch_id=p_launch order by created_at desc,id desc limit 1;
 return jsonb_build_object('id',r.id,'version',r.aggregate_version::text,'draft',r.draft_config,'expectedSourceSnapshot',r.expected_source_snapshot,'assigneeId',r.assignee_id,'workStatus',r.work_status,'activeRevision',private.launch_revision_json(p_team,coalesce(p_revision,r.active_revision_id)),'generation',g);
end $$;
create function public.list_launches(p_team uuid,p_filter jsonb default '{}',p_limit integer default 50) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.launch_access(p_team,'view');if p_limit not between 1 and 100 or jsonb_typeof(p_filter)<>'object' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select coalesce(jsonb_agg(summary order by launch_date desc nulls last,id desc),'[]') into result from (
 select l.id,l.effective_launch_date launch_date,jsonb_build_object('id',l.id,'version',l.aggregate_version::text,'launchDate',l.effective_launch_date,
 'offer',coalesce(r.sources->>'offer',o.name,''),'social',coalesce(r.sources->>'social',a.name,''),'creativeAlias',coalesce(r.config->>'creativeAlias',l.draft_config->>'creativeAlias',''),
 'method',coalesce(r.config->>'method',l.draft_config->>'method','other'),'workStatus',l.work_status,'assigneeId',l.assignee_id,
 'budgets',coalesce((select jsonb_agg(c.budget_usd order by c.ordinal) from public.team_launch_campaigns c where c.revision_id=coalesce(r.baseline_revision_id,r.id)),'[]'),
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
 and (nullif(p_filter->>'search','') is null or position(lower(p_filter->>'search') in lower(coalesce(r.sources->>'offer',o.name,'')||' '||coalesce(r.config->>'creativeAlias',l.draft_config->>'creativeAlias',''))) > 0)
 order by l.effective_launch_date desc nulls last,l.id desc limit p_limit
 ) page;
 return jsonb_build_object('items',result,'nextCursor',case when jsonb_array_length(result)=p_limit then jsonb_build_object('id',result->(p_limit-1)->>'id','date',result->(p_limit-1)->>'launchDate') else null end);
end $$;
create function public.update_launch_metadata(p_team uuid,p_launch uuid,p_expected_version text,p_request_key text,p_status text,p_assignee uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.team_launches%rowtype;payload jsonb:=jsonb_build_array(p_launch,p_expected_version,p_status,p_assignee);result jsonb;replay jsonb;
begin
 perform private.launch_access(p_team,'edit');replay:=private.launch_request(p_team,p_request_key,'metadata',payload);if replay is not null then return replay;end if;
 select * into r from public.team_launches where team_id=p_team and id=p_launch and archived_at is null for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;perform private.launch_unlocked(p_team,p_launch);
 if p_expected_version is null or r.aggregate_version::text<>p_expected_version then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 if p_status not in('todo','in_progress','done') or p_status is null or (p_assignee is not null and not private.team_task_assignee_is_active(p_team,p_assignee)) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 update public.team_launches set work_status=p_status,assignee_id=p_assignee,assignee_label_snapshot=private.team_task_assignee_label(p_assignee),aggregate_version=aggregate_version+1,updated_at=clock_timestamp() where id=p_launch returning * into r;
 result:=jsonb_build_object('id',r.id,'version',r.aggregate_version::text);perform private.launch_signal(p_team,r.id,r.aggregate_version);perform private.launch_remember(p_team,p_request_key,'metadata',payload,result);return result;
end $$;
-- No helper is executable by a browser; explicit client entrypoint grants only.
revoke all on function private.launch_access(uuid,text),private.launch_request(uuid,text,text,jsonb),private.launch_remember(uuid,text,text,jsonb,jsonb),private.launch_unlocked(uuid,uuid),private.launch_signal(uuid,uuid,bigint),private.launch_revision_json(uuid,uuid) from public,anon,authenticated;
revoke all on function public.list_launch_dictionaries(uuid),public.create_launch_dictionary(uuid,text,text,text),public.save_launch_draft(uuid,uuid,text,text,jsonb,jsonb),public.get_launch(uuid,uuid,uuid),public.list_launches(uuid,jsonb,integer),public.update_launch_metadata(uuid,uuid,text,text,text,uuid) from public,anon;
grant execute on function public.list_launch_dictionaries(uuid),public.create_launch_dictionary(uuid,text,text,text),public.save_launch_draft(uuid,uuid,text,text,jsonb,jsonb),public.get_launch(uuid,uuid,uuid),public.list_launches(uuid,jsonb,integer),public.update_launch_metadata(uuid,uuid,text,text,text,uuid) to authenticated;
