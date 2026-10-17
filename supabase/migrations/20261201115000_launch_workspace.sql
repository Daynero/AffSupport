create function public.get_launch_defaults(p_team uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 perform private.launch_access(p_team,'view');return (select jsonb_build_object('config',config,'subConfig',sub_config,'version',version::text) from public.team_launch_defaults where team_id=p_team);
end $$;
create function public.set_launch_defaults(p_team uuid,p_expected_version text,p_key text,p_config jsonb,p_sub_config jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.team_launch_defaults%rowtype;result jsonb;replay jsonb;payload jsonb:=jsonb_build_array(p_expected_version,p_config,p_sub_config);k text;v jsonb;
begin
 perform private.launch_access(p_team,'manage_metadata');replay:=private.launch_request(p_team,p_key,'defaults',payload);if replay is not null then return replay;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text||'launch-defaults',0));
 if jsonb_typeof(p_config)<>'object' or p_config is null or octet_length(p_config::text)>8192 or p_sub_config is null or jsonb_typeof(p_sub_config)<>'object' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for k,v in select key,value from jsonb_each(p_config) loop
  if k not in('buyerId','campaignCount','maxBudget','adsCount','age','gender','method','advantagePlus','catalog') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 if p_config ? 'buyerId' and not exists(select 1 from public.team_launch_buyers where team_id=p_team and id=(p_config->>'buyerId')::uuid and archived_at is null) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if p_sub_config->>'schemaVersion'<>'1' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for k in select unnest(array['sub1','sub2','sub3']) loop
  if jsonb_typeof(p_sub_config->k)<>'array' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if jsonb_array_length(p_sub_config->k)>4 or exists(select 1 from jsonb_array_elements_text(p_sub_config->k) x where x not in('buyer','social','adAccountSuffix','creative')) or (select count(*)<>count(distinct x) from jsonb_array_elements_text(p_sub_config->k) x) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 select * into d from public.team_launch_defaults where team_id=p_team for update;
 if (found and (p_expected_version is null or d.version::text<>p_expected_version)) or (not found and p_expected_version is not null) then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 insert into public.team_launch_defaults(team_id,config,sub_config,updated_by) values(p_team,p_config,p_sub_config,auth.uid()) on conflict(team_id) do update set config=excluded.config,sub_config=excluded.sub_config,version=team_launch_defaults.version+1,updated_by=auth.uid(),updated_at=clock_timestamp() returning * into d;
 result:=jsonb_build_object('version',d.version::text);perform private.launch_remember(p_team,p_key,'defaults',payload,result);return result;
end $$;
create function public.archive_launch_dictionary(p_team uuid,p_kind text,p_id uuid,p_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;replay jsonb;payload jsonb:=jsonb_build_array(p_kind,p_id);begin
 perform private.launch_access(p_team,'manage_metadata');replay:=private.launch_request(p_team,p_key,'dictionary-archive',payload);if replay is not null then return replay;end if;
 if p_kind='buyers' then update public.team_launch_buyers set archived_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_id and team_id=p_team;
 elsif p_kind='offers' then update public.team_launch_offers set archived_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_id and team_id=p_team;
 else raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 result:=jsonb_build_object('id',p_id);perform private.launch_remember(p_team,p_key,'dictionary-archive',payload,result);return result;
end $$;
revoke all on function public.get_launch_defaults(uuid),public.set_launch_defaults(uuid,text,text,jsonb,jsonb),public.archive_launch_dictionary(uuid,text,uuid,text) from public,anon;
grant execute on function public.get_launch_defaults(uuid),public.set_launch_defaults(uuid,text,text,jsonb,jsonb),public.archive_launch_dictionary(uuid,text,uuid,text) to authenticated;
