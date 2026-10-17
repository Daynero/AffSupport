create function public.list_launch_revisions(p_team uuid,p_launch uuid,p_before integer default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform private.launch_access(p_team,'view');
 if not exists(select 1 from public.team_launches where team_id=p_team and id=p_launch) then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 return coalesce((select jsonb_agg(row order by revision_no desc) from (
 select r.revision_no,jsonb_build_object('id',r.id,'revisionNo',r.revision_no,'kind',r.result_kind,'createdAt',r.created_at,'state',g.state) row
 from public.team_launch_revisions r left join public.team_launch_generations g on g.revision_id=r.id
 where r.team_id=p_team and r.launch_id=p_launch and (p_before is null or r.revision_no<p_before) order by r.revision_no desc limit 50) page),'[]');
end $$;
create function public.save_launch_overrides(p_team uuid,p_launch uuid,p_baseline uuid,p_expected_version text,p_request_key text,p_overrides jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.team_launches%rowtype;r public.team_launch_revisions%rowtype;old public.team_launch_revisions%rowtype;new_id uuid:=gen_random_uuid();n integer;result jsonb;replay jsonb;payload jsonb:=jsonb_build_array(p_launch,p_baseline,p_expected_version,p_overrides);k text;v jsonb;ordinal_key text;row jsonb;
begin
 perform private.launch_access(p_team,'edit');replay:=private.launch_request(p_team,p_request_key,'overrides',payload);if replay is not null then return replay;end if;
 select * into l from public.team_launches where id=p_launch and team_id=p_team and archived_at is null for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;perform private.launch_unlocked(p_team,p_launch);
 if l.aggregate_version::text<>p_expected_version or p_expected_version is null then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 select * into old from public.team_launch_revisions where id=l.active_revision_id;
 select * into r from public.team_launch_revisions where id=p_baseline and team_id=p_team and launch_id=p_launch and result_kind='generated';
 if not found or coalesce(old.baseline_revision_id,old.id)<>p_baseline then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 if p_overrides is null or jsonb_typeof(p_overrides)<>'object' or octet_length(p_overrides::text)>262144 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for k,v in select key,value from jsonb_each(p_overrides) loop
  if k in('advertisingUrl','catalogName','catalogUrl') then
   if jsonb_typeof(v)<>'string' or char_length(v #>> '{}') not between 1 and 8192 or (v #>> '{}') ~ '[[:cntrl:]]' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if k in('advertisingUrl','catalogUrl') and ((v #>> '{}') !~* '^https?://[^/[:space:]?#]+' or (v #>> '{}') ~ '[[:space:]]') then raise exception 'LAUNCH_URL_INVALID' using errcode='22023';end if;
   if k in('catalogName','catalogUrl') and not exists(select 1 from public.team_launch_revision_catalogs where revision_id=old.id) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  elsif k='subValues' then
   if jsonb_typeof(v)<>'object' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if exists(select 1 from jsonb_each(v) x where x.key not in('sub1','sub2','sub3') or jsonb_typeof(x.value)<>'string' or char_length(x.value #>> '{}')>160 or (x.value #>> '{}') !~ '^[A-Za-z0-9_-]+$') then raise exception 'LAUNCH_SUB_INVALID' using errcode='22023';end if;
  elsif k='campaigns' then
   if jsonb_typeof(v)<>'object' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   for ordinal_key,row in select key,value from jsonb_each(v) loop
    if ordinal_key !~ '^[1-9][0-9]{0,2}$' or not exists(select 1 from public.team_launch_campaigns where revision_id=p_baseline and team_launch_campaigns.ordinal=ordinal_key::integer) or jsonb_typeof(row)<>'object' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
    if exists(select 1 from jsonb_each(row) x where x.key not in('name','budget','adRange') or jsonb_typeof(x.value)<>'string' or char_length(x.value #>> '{}') not between 1 and 2000 or (x.value #>> '{}') ~ '[[:cntrl:]]') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
    if row ? 'budget' and ((row->>'budget') !~ '^[1-9][0-9]{0,15}$' or (row->>'budget')::numeric>9007199254740991) then raise exception 'LAUNCH_BUDGET_INVALID' using errcode='22023';end if;
    if row ? 'adRange' then
     if (row->>'adRange') !~ '^[1-9][0-9]{0,15}-[1-9][0-9]{0,15}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
     if split_part(row->>'adRange','-',1)::numeric>split_part(row->>'adRange','-',2)::numeric or split_part(row->>'adRange','-',2)::numeric>9007199254740991 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
    end if;
   end loop;
  else raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 select coalesce(max(revision_no),0)+1 into n from public.team_launch_revisions where launch_id=p_launch;
 insert into public.team_launch_revisions(id,team_id,launch_id,revision_no,result_kind,base_revision_id,baseline_revision_id,config,sources,original_url,generated_url,sub_values,result_overrides,created_by)
 values(new_id,p_team,p_launch,n,'manual',old.id,p_baseline,r.config,r.sources,r.original_url,r.generated_url,r.sub_values,p_overrides,auth.uid());
 insert into public.team_launch_revision_catalogs select team_id,new_id,catalog_id,material_id,variant,name_snapshot,sheet_url,restitch_operation_id,restitch_material_id,settings_snapshot from public.team_launch_revision_catalogs where revision_id=old.id;
 update public.team_launches set active_revision_id=new_id,aggregate_version=aggregate_version+1,updated_at=clock_timestamp() where id=p_launch returning * into l;
 result:=jsonb_build_object('id',l.id,'version',l.aggregate_version::text,'revisionId',new_id);
 perform private.launch_signal(p_team,p_launch,l.aggregate_version);perform private.launch_remember(p_team,p_request_key,'overrides',payload,result);return result;
end $$;
revoke all on function public.list_launch_revisions(uuid,uuid,integer),public.save_launch_overrides(uuid,uuid,uuid,text,text,jsonb) from public,anon;
grant execute on function public.list_launch_revisions(uuid,uuid,integer),public.save_launch_overrides(uuid,uuid,uuid,text,text,jsonb) to authenticated;
