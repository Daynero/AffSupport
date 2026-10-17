-- Permission-only Drive revision changes do not invalidate an unchanged binary preview.
create function private.launch_sources_equivalent(p_before jsonb,p_after jsonb) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(p_before)='object' and jsonb_typeof(p_after)='object' and
  (p_before=p_after or (p_before->>'materialChecksum' ~* '^[0-9a-f]{32}$'
   and p_after->>'materialChecksum' ~* '^[0-9a-f]{32}$'
   and private.launch_material_identity(p_before)=private.launch_material_identity(p_after)
   and (p_before-'materialVersion')=(p_after-'materialVersion'))),false);
$$;
revoke all on function private.launch_sources_equivalent(jsonb,jsonb) from public,anon,authenticated,service_role;
create or replace function public.service_accept_launch_generation(p_team uuid,p_launch uuid,p_actor uuid,p_expected_version text,p_key text,p_digest text,p_config jsonb,p_sources jsonb,p_preview jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
 if not private.launch_sources_equivalent(p_sources,fresh) or l.expected_source_snapshot is null or not private.launch_sources_equivalent(l.expected_source_snapshot,fresh) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
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
