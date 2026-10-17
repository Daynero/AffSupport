create function public.service_launch_sources(p_team uuid,p_launch uuid,p_actor uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare l public.team_launches%rowtype;a public.team_account_agents%rowtype;s public.team_accounts%rowtype;m public.team_materials%rowtype;o public.team_launch_offers%rowtype;b public.team_launch_buyers%rowtype;
begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into l from public.team_launches where id=p_launch and team_id=p_team and archived_at is null;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select * into a from public.team_account_agents where id=(l.draft_config->>'agentRowId')::uuid and team_id=p_team;
 select * into s from public.team_accounts where id=a.account_id and team_id=p_team;
 select * into m from public.team_materials where id=(l.draft_config->>'materialId')::uuid and team_id=p_team and lifecycle='active' and kind='file' and category in('video','image');
 select * into o from public.team_launch_offers where id=(l.draft_config->>'offerId')::uuid and team_id=p_team and archived_at is null;
 select * into b from public.team_launch_buyers where id=(l.draft_config->>'buyerId')::uuid and team_id=p_team and archived_at is null;
 if a.id is null or s.id is null or m.id is null or o.id is null or b.id is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 return jsonb_build_object('schemaVersion',1,'agentRowId',a.id,'accountId',s.id,'social',s.name,'agentId',a.agent_id,'offerId',o.id,'offer',o.name,'buyerId',b.id,'buyer',b.value,'materialId',m.id,'materialType',m.category,'materialVersion',m.drive_version,'catalogSettingsVersion',null);
end $$;
create function public.get_launch_sources(p_team uuid,p_launch uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 perform private.launch_access(p_team,'edit');return public.service_launch_sources(p_team,p_launch,auth.uid());end $$;
create function public.service_accept_launch_generation(p_team uuid,p_launch uuid,p_actor uuid,p_expected_version text,p_key text,p_digest text,p_config jsonb,p_sources jsonb,p_preview jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.team_launches%rowtype;g public.team_launch_generations%rowtype;r uuid:=gen_random_uuid();n integer;row jsonb;fresh jsonb;
begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,200}$' or p_digest is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text||p_key,0));
 select * into g from public.team_launch_generations where team_id=p_team and request_key=p_key;
 if found then
  if g.actor_id<>p_actor or g.request_digest<>p_digest or g.launch_id<>p_launch then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
  return jsonb_build_object('id',g.id,'revisionId',g.revision_id,'fence',g.fence::text,'state',g.state,'replayed',true);
 end if;
 select * into l from public.team_launches where id=p_launch and team_id=p_team and archived_at is null for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if l.aggregate_version::text<>p_expected_version or l.draft_config<>p_config then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 if exists(select 1 from public.team_launch_generations where launch_id=p_launch and state not in('succeeded','canceled')) then raise exception 'LAUNCH_BUSY' using errcode='55000';end if;
 fresh:=public.service_launch_sources(p_team,p_launch,p_actor);
 if p_sources<>fresh or l.expected_source_snapshot is null or l.expected_source_snapshot<>fresh then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if jsonb_typeof(p_preview->'campaigns')<>'array' or jsonb_array_length(p_preview->'campaigns')<>(p_config->>'campaignCount')::integer or (p_config->>'campaignCount')::integer not between 1 and 100 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select coalesce(max(revision_no),0)+1 into n from public.team_launch_revisions where launch_id=p_launch;
 insert into public.team_launch_revisions(id,team_id,launch_id,revision_no,result_kind,base_revision_id,config,sources,original_url,generated_url,sub_values,created_by)
 values(r,p_team,p_launch,n,'generated',l.active_revision_id,p_config,p_sources,p_config->>'originalUrl',p_preview->>'advertisingUrl',p_preview->'subValues',p_actor);
 for row in select value from jsonb_array_elements(p_preview->'campaigns') loop
  insert into public.team_launch_campaigns(team_id,revision_id,ordinal,budget_usd,ad_start,ad_end,name) values(p_team,r,(row->>'ordinal')::integer,(row->>'budget')::integer,(row->>'adStart')::integer,(row->>'adEnd')::integer,row->>'name');
 end loop;
 insert into public.team_launch_generations(team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version) values(p_team,p_launch,r,p_actor,p_key,p_digest,p_expected_version) returning * into g;
 update public.team_launches set aggregate_version=aggregate_version+1,updated_at=clock_timestamp() where id=p_launch returning * into l;
 perform private.launch_signal(p_team,p_launch,l.aggregate_version);
 return jsonb_build_object('id',g.id,'revisionId',r,'fence',g.fence::text,'state',g.state,'replayed',false);
end $$;
create function public.service_publish_launch_generation(p_team uuid,p_generation uuid,p_actor uuid,p_fence text) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;r public.team_launch_revisions%rowtype;
begin
 if not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 -- All mutations lock aggregate before generation to avoid cancel/commit deadlocks.
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if g.state='succeeded' then return jsonb_build_object('id',g.id,'state',g.state,'revisionId',g.revision_id);end if;
 if g.fence::text<>p_fence or g.state not in('accepted','running') or l.archived_at is not null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 if r.config->>'method'='catalog' and not exists(select 1 from public.team_launch_revision_catalogs where revision_id=r.id) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 update public.team_launch_generations set state='succeeded',stage='result_committed',state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 update public.team_launches set active_revision_id=r.id,effective_launch_date=(r.config->>'launchDate')::date,aggregate_version=aggregate_version+1,updated_at=clock_timestamp() where id=l.id returning * into l;
 perform private.launch_signal(p_team,l.id,l.aggregate_version);
 return jsonb_build_object('id',g.id,'state','succeeded','revisionId',r.id);
end $$;
create function public.cancel_launch_generation(p_team uuid,p_launch uuid,p_generation uuid,p_request_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;replay jsonb;result jsonb;payload jsonb:=jsonb_build_array(p_launch,p_generation);
begin
 perform private.launch_access(p_team,'edit');replay:=private.launch_request(p_team,p_request_key,'cancel',payload);if replay is not null then return replay;end if;
 select * into l from public.team_launches where id=p_launch and team_id=p_team for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select * into g from public.team_launch_generations where id=p_generation and launch_id=p_launch and team_id=p_team for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if g.state not in('succeeded','canceled') then
  update public.team_launch_generations set state=case when exists(select 1 from public.team_launch_generation_steps where generation_id=g.id) then 'cancel_requested' else 'canceled' end,
  stage='cancel',cancel_requested_at=clock_timestamp(),fence=fence+1,state_version=state_version+1,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() where id=g.id returning * into g;
  update public.team_launches set aggregate_version=aggregate_version+1,updated_at=clock_timestamp() where id=l.id returning * into l;
  perform private.launch_signal(p_team,l.id,l.aggregate_version);
 end if;
 result:=jsonb_build_object('id',g.id,'state',g.state);perform private.launch_remember(p_team,p_request_key,'cancel',payload,result);return result;
end $$;
create function public.find_launch_generation(p_team uuid,p_key text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;
begin
 perform private.launch_access(p_team,'view');select * into g from public.team_launch_generations where team_id=p_team and request_key=p_key and actor_id=auth.uid();
 if not found then return null;end if;return jsonb_build_object('id',g.id,'launchId',g.launch_id,'revisionId',g.revision_id,'state',g.state,'expectedVersion',g.input_version,'fence',g.fence::text,'method',(select config->>'method' from public.team_launch_revisions where id=g.revision_id));
end $$;
revoke all on function public.service_launch_sources(uuid,uuid,uuid),public.service_accept_launch_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb),public.service_publish_launch_generation(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_launch_sources(uuid,uuid,uuid),public.service_accept_launch_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb),public.service_publish_launch_generation(uuid,uuid,uuid,text) to service_role;
revoke all on function public.get_launch_sources(uuid,uuid),public.cancel_launch_generation(uuid,uuid,uuid,text),public.find_launch_generation(uuid,text) from public,anon;
grant execute on function public.get_launch_sources(uuid,uuid),public.cancel_launch_generation(uuid,uuid,uuid,text),public.find_launch_generation(uuid,text) to authenticated;
