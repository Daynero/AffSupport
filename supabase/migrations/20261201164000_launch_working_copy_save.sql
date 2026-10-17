-- Historical restore can preserve draft and output edits together using existing mutators.
create function public.save_launch_working_copy(
 p_team uuid,p_launch uuid,p_expected_version text,p_request_key text,
 p_config jsonb,p_expected_sources jsonb,p_baseline uuid,p_overrides jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;replay jsonb;version text:=p_expected_version;
 payload jsonb:=jsonb_build_array(p_launch,p_expected_version,p_config,p_expected_sources,p_baseline,p_overrides);
 child_key text;
begin
 perform private.launch_access(p_team,'edit');
 replay:=private.launch_request(p_team,p_request_key,'working-copy',payload);
 if replay is not null then return replay;end if;
 if p_launch is null or (p_config is null and p_overrides is null)
  or (p_config is null and p_expected_sources is not null)
  or (p_overrides is null)<>(p_baseline is null) then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 if p_config is not null then
  child_key:='working_draft_'||encode(extensions.digest(p_request_key,'sha256'),'hex');
  result:=public.save_launch_draft(p_team,p_launch,version,child_key,p_config,p_expected_sources);
  version:=result->>'version';
 end if;
 if p_overrides is not null then
  child_key:='working_outputs_'||encode(extensions.digest(p_request_key,'sha256'),'hex');
  result:=public.save_launch_overrides(p_team,p_launch,p_baseline,version,child_key,p_overrides);
 end if;
 perform private.launch_remember(p_team,p_request_key,'working-copy',payload,result);
 return result;
end $$;
revoke all on function public.save_launch_working_copy(uuid,uuid,text,text,jsonb,jsonb,uuid,jsonb) from public,anon;
grant execute on function public.save_launch_working_copy(uuid,uuid,text,text,jsonb,jsonb,uuid,jsonb) to authenticated;
