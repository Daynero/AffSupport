-- Versioned catalog SUBs are resolved from the durable name reservation, never a forecast.
create or replace function private.validate_launch_defaults_row() returns trigger language plpgsql security definer set search_path='' as $$
declare k text;v jsonb;limit_value numeric;c jsonb;begin
 if jsonb_typeof(new.config) is distinct from 'object' or jsonb_typeof(new.sub_config) is distinct from 'object' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for k,v in select key,value from jsonb_each(new.config) loop
  if k not in('buyerId','campaignCount','minBudget','maxBudget','adsCount','age','gender','method','advantagePlus','catalog','budgetMode','budgets') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if k in('campaignCount','minBudget','maxBudget','adsCount','age') then
   limit_value:=case k when 'campaignCount' then 100 when 'maxBudget' then 999999 when 'minBudget' then 999999 when 'adsCount' then 1000 else 9007199254740991 end;
   if jsonb_typeof(v) is distinct from 'number' or v::text !~ '^[0-9]+$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if (v::text)::numeric not between 1 and limit_value then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  elsif k='gender' and v#>>'{}' not in('M','W','ALL') or k='method' and v#>>'{}' not in('catalog','other') or k='advantagePlus' and jsonb_typeof(v) is distinct from 'boolean' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 if new.config ? 'gender' and jsonb_typeof(new.config->'gender') is distinct from 'string' or new.config ? 'method' and jsonb_typeof(new.config->'method') is distinct from 'string' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if new.config ? 'buyerId' and (jsonb_typeof(new.config->'buyerId') is distinct from 'string' or not exists(select 1 from public.team_launch_buyers where team_id=new.team_id and id::text=new.config->>'buyerId' and archived_at is null)) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if new.config ? 'minBudget' and new.config ? 'maxBudget' and (new.config->>'minBudget')::numeric>(new.config->>'maxBudget')::numeric then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if new.config ? 'budgetMode' and (jsonb_typeof(new.config->'budgetMode') is distinct from 'string' or new.config->>'budgetMode' not in('auto','manual')) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if new.config->>'budgetMode'='manual' then
  if jsonb_typeof(new.config->'budgets') is distinct from 'array' or not (new.config ? 'campaignCount' and new.config ? 'maxBudget') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if jsonb_array_length(new.config->'budgets')<>(new.config->>'campaignCount')::integer then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  limit_value:=0;
  for v in select value from jsonb_array_elements(new.config->'budgets') loop
   if jsonb_typeof(v) is distinct from 'number' or v::text !~ '^[0-9]+$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if v::text::numeric<=limit_value or v::text::numeric<coalesce((new.config->>'minBudget')::numeric,1) or v::text::numeric>(new.config->>'maxBudget')::numeric then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   limit_value:=v::text::numeric;
  end loop;
  if limit_value<>(new.config->>'maxBudget')::numeric then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 elsif new.config ? 'budgets' and new.config->'budgets'<>'null'::jsonb then raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 if new.config->>'budgetMode'='auto' and new.config ? 'campaignCount' and new.config ? 'maxBudget' and (new.config->>'campaignCount')::integer>(new.config->>'maxBudget')::integer-coalesce((new.config->>'minBudget')::integer,1)+1 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if octet_length(new.config::text)>8192 or octet_length(new.sub_config::text)>1024 or exists(select 1 from jsonb_object_keys(new.sub_config) allowed_key where allowed_key not in('schemaVersion','sub1','sub2','sub3')) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 c:=new.config->'catalog';
 if c is not null then
  if jsonb_typeof(c) is distinct from 'object' or jsonb_typeof(c->'productCount') is distinct from 'number' or c->>'productCount' !~ '^[0-9]+$' or jsonb_typeof(c->'restitchEnabled') is distinct from 'boolean' or jsonb_typeof(c->'finalDurationMode') is distinct from 'string' or c->>'finalDurationMode' not in('random-30-40','random-40-50','random-50-60','random-centered','custom') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if exists(select 1 from jsonb_object_keys(c) allowed_key where allowed_key not in('productCount','restitchEnabled','finalDurationMode','customFinalDurationSeconds','finalDurationRangeSeconds')) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if c ? 'finalDurationRangeSeconds' then
   if jsonb_typeof(c->'finalDurationRangeSeconds') is distinct from 'array' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if jsonb_array_length(c->'finalDurationRangeSeconds')<>2 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   for v in select value from jsonb_array_elements(c->'finalDurationRangeSeconds') loop
    if jsonb_typeof(v) is distinct from 'number' or v::text !~ '^[0-9]+$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
    if (v::text)::numeric not between 60 and 3600 or mod((v::text)::numeric,60)<>0 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   end loop;
   if (c->'finalDurationRangeSeconds'->>0)::numeric>(c->'finalDurationRangeSeconds'->>1)::numeric then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  end if;
  if (c->>'productCount')::numeric not between 1 and 400 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if c->'customFinalDurationSeconds' is distinct from 'null'::jsonb then
   if jsonb_typeof(c->'customFinalDurationSeconds') is distinct from 'number' or c->>'customFinalDurationSeconds' !~ '^[0-9]+$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if (c->>'customFinalDurationSeconds')::numeric not between 60 and 3600 or mod((c->>'customFinalDurationSeconds')::numeric,60)<>0 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  elsif c->>'finalDurationMode' in('custom','random-centered') and c->>'restitchEnabled'='true' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end if;
 if new.sub_config->'schemaVersion' is distinct from '1'::jsonb then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for k in select unnest(array['sub1','sub2','sub3']) loop
  if jsonb_typeof(new.sub_config->k) is distinct from 'array' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if jsonb_array_length(new.sub_config->k)>5 or exists(select 1 from jsonb_array_elements(new.sub_config->k) x where jsonb_typeof(x) is distinct from 'string' or x#>>'{}' not in('buyer','social','adAccountSuffix','creative','catalogName')) or (select count(*)<>count(distinct x) from jsonb_array_elements(new.sub_config->k) x) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 return new;
end $$;

create function public.service_bind_launch_catalog_subs(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text,p_name text,p_url text,p_sub_values jsonb) returns void language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;i private.catalog_generation_intents%rowtype;bound jsonb;begin
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_planning');
 select * into g from public.team_launch_generations where team_id=p_team and id=p_generation;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and request_key='launch:'||g.id::text||':catalog' for update;
 if i.id is null or i.video_material_id::text is distinct from r.config->>'materialId'
  or i.checkpoint->'namePlan'->>'name' is distinct from p_name
  or r.config->>'method' is distinct from 'catalog'
  or not exists(select 1 from jsonb_each(r.config->'subConfig') c where jsonb_typeof(c.value)='array' and c.value ? 'catalogName')
  then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if p_name is null or p_name='' or char_length(p_name)>512 or p_url is null or char_length(p_url)>8192 or p_url !~* '^https?://[^/[:space:]?#]+'
  or jsonb_typeof(p_sub_values) is distinct from 'object' or not(p_sub_values ?& array['sub1','sub2','sub3'])
  or exists(select 1 from jsonb_each(p_sub_values) x where x.key not in('sub1','sub2','sub3') or jsonb_typeof(x.value) not in('string','null') or char_length(x.value#>>'{}')>512)
  then raise exception 'LAUNCH_SUB_INVALID' using errcode='22023';end if;
 bound:=jsonb_build_object('name',p_name,'advertisingUrl',p_url,'subValues',p_sub_values);
 if i.checkpoint ? 'launchSubBinding' and i.checkpoint->'launchSubBinding' is distinct from bound then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 update private.catalog_generation_intents set checkpoint=checkpoint||jsonb_build_object('launchSubBinding',bound),updated_at=clock_timestamp() where id=i.id;
end $$;
revoke all on function public.service_bind_launch_catalog_subs(uuid,uuid,uuid,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.service_bind_launch_catalog_subs(uuid,uuid,uuid,text,text,text,text,jsonb) to service_role;

-- Keep the request URL immutable for child idempotency and resource snapshots.
-- The resolved URL becomes a revision baseline only with the registered catalog.
alter function public.service_attach_launch_catalog(uuid,uuid,uuid,text,text) rename to service_attach_launch_catalog_before_catalog_sub;
revoke all on function public.service_attach_launch_catalog_before_catalog_sub(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.service_attach_launch_catalog(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns void language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;i private.catalog_generation_intents%rowtype;r public.team_launch_revisions%rowtype;bound jsonb;begin
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_registering');
 select * into g from public.team_launch_generations where team_id=p_team and id=p_generation;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 if exists(select 1 from jsonb_each(r.config->'subConfig') c where jsonb_typeof(c.value)='array' and c.value ? 'catalogName') then
  select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and request_key='launch:'||g.id::text||':catalog' and state='registered';
  bound:=i.checkpoint->'launchSubBinding';
  if bound is null or bound->>'name' is distinct from i.checkpoint->'namePlan'->>'name'
   or not exists(select 1 from public.team_materials m where m.team_id=p_team and m.id=(i.result->'catalog'->>'materialId')::uuid and m.name=bound->>'name')
   then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  update public.team_launch_revisions set generated_url=bound->>'advertisingUrl',sub_values=bound->'subValues' where id=r.id;
 end if;
 perform public.service_attach_launch_catalog_before_catalog_sub(p_team,p_generation,p_actor,p_owner,p_fence);
end $$;
revoke all on function public.service_attach_launch_catalog(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_attach_launch_catalog(uuid,uuid,uuid,text,text) to service_role;

-- A revision is immutable once published. The only pre-publication amendment is
-- the exact catalog binding proved by the registered durable child.
create function private.launch_revision_catalog_sub_binding() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (to_jsonb(new)-'generated_url'-'sub_values') is distinct from (to_jsonb(old)-'generated_url'-'sub_values')
  or exists(select 1 from public.team_launches l where l.active_revision_id=old.id)
  or not exists(
   select 1 from public.team_launch_generations g
   join private.catalog_generation_intents i on i.team_id=g.team_id and i.actor_id=g.actor_id and i.request_key='launch:'||g.id::text||':catalog'
   join public.team_product_catalogs c on c.team_id=g.team_id and c.material_id=(i.result->'catalog'->>'materialId')::uuid
   join public.team_materials m on m.id=c.material_id and m.team_id=c.team_id
   where g.revision_id=old.id and g.state='running' and i.state='registered'
    and i.checkpoint->'launchSubBinding'->>'advertisingUrl'=new.generated_url
    and i.checkpoint->'launchSubBinding'->'subValues'=new.sub_values
    and i.checkpoint->'launchSubBinding'->>'name'=m.name
    and c.source_link=new.generated_url
  ) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return new;
end $$;
revoke all on function private.launch_revision_catalog_sub_binding() from public,anon,authenticated,service_role;
drop trigger launch_revision_immutable on public.team_launch_revisions;
create trigger launch_revision_immutable before update on public.team_launch_revisions for each row execute function private.launch_revision_catalog_sub_binding();

-- Privacy-safe diagnosis: status only, never the name, URL or SUB values.
create or replace view public.analytics_launch_generations as
select g.id generation_id,g.team_id,g.launch_id,g.actor_id,g.revision_id,
 case when g.request_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then g.request_key else null end flow_id,
 g.state,case when g.stage in('accepted','preparing','restitch_preparing','restitch_processing','restitch_uploading','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing','result_committed','cancel','cleanup') then g.stage else 'unknown' end stage,
 g.state_version::text,g.attempt_no,g.retryable,g.cancel_requested_at,g.created_at,g.updated_at,
 g.lease_expires_at,g.next_attempt_at,
 case when g.safe_error_code in('INVALID_INPUT','INVALID_RESPONSE','SOURCE_CHANGED','PERMISSION_DENIED','NOT_FOUND','SPACE_BLOCKED','LAUNCH_BUSY','LAUNCH_VERSION_CONFLICT','LAUNCH_URL_INVALID','LAUNCH_SUB_INVALID','LAUNCH_BUDGET_INVALID','LAUNCH_RESULT_UNCERTAIN','LEASE_MISMATCH','DRIVE_UNAVAILABLE','DRIVE_FILE_MISSING','AGENT_UPDATE_REQUIRED','AGENT_REQUIRED','NEEDS_REAUTH','RESTITCH_INVALID','RESTITCH_NO_SCREENS','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID','RESTITCH_CLIENT_OUTDATED','PROCESS_FAILED','PROCESS_CANCELED','WRONG_STATE','LAUNCH_INTERNAL_ERROR','SHARE_NOT_ALLOWED','NO_WORK') then g.safe_error_code when g.safe_error_code is not null then 'UNKNOWN' else null end safe_error_code,
 case when r.config->>'method'='catalog' then 'catalog' else 'other' end method,
 coalesce(l.active_revision_id=g.revision_id,false) result_is_active,
 exists(select 1 from public.team_launch_revision_catalogs c where c.revision_id=g.revision_id) catalog_registered,
 coalesce((select jsonb_agg(jsonb_build_object('stage',s.stage,'state',s.state,'child_operation_id',s.team_operation_id,'created_at',s.created_at,'updated_at',s.updated_at) order by s.created_at,s.id)
 from public.team_launch_generation_steps s where s.generation_id=g.id and s.stage in('preparing','restitch_preparing','restitch_processing','restitch_uploading','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing','cleanup')),'[]'::jsonb) steps,
 jsonb_build_object(
  'video_operation_id',(select c.restitch_operation_id from public.team_launch_revision_catalogs c where c.revision_id=r.id and c.team_id=g.team_id),
  'video_generation_id',(select prep.generation_id from public.team_launch_revision_catalogs c
    join private.launch_restitch_preparations prep on prep.team_id=c.team_id and prep.operation_id=c.restitch_operation_id
    where c.revision_id=r.id and c.team_id=g.team_id limit 1),
  'catalog_revision_id',(select prior.revision_id from public.team_launch_revision_catalogs c
    join public.team_launch_revision_catalogs prior on prior.team_id=c.team_id and prior.material_id=c.material_id and prior.revision_id=r.base_revision_id
    where c.revision_id=r.id and c.team_id=g.team_id)
 ) reuse_evidence,
 jsonb_build_object(
  'required',exists(select 1 from jsonb_each(r.config->'subConfig') c where jsonb_typeof(c.value)='array' and c.value ? 'catalogName'),
  'resolved',exists(select 1 from private.catalog_generation_intents i where i.team_id=g.team_id and i.request_key='launch:'||g.id::text||':catalog' and i.checkpoint ? 'launchSubBinding'),
  'committed',g.state='succeeded' and exists(select 1 from private.catalog_generation_intents i join public.team_launch_revision_catalogs c on c.revision_id=r.id and c.team_id=g.team_id where i.team_id=g.team_id and i.request_key='launch:'||g.id::text||':catalog' and i.state='registered' and i.checkpoint->'launchSubBinding'->>'advertisingUrl'=r.generated_url and i.checkpoint->'launchSubBinding'->'subValues'=r.sub_values)
 ) catalog_sub_binding
from public.team_launch_generations g join public.team_launch_revisions r on r.id=g.revision_id and r.team_id=g.team_id join public.team_launches l on l.id=g.launch_id and l.team_id=g.team_id;
