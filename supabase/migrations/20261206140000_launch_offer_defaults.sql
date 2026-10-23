-- Independent workspace/offer profiles; request receipts contain no configuration.
create table public.team_launch_offer_defaults (
 team_id uuid not null references public.teams(id) on delete cascade,
 offer_id uuid not null,
 config jsonb not null default '{}',
 sub_config jsonb not null default '{"schemaVersion":1,"sub1":[],"sub2":[],"sub3":[]}',
 version bigint not null default 1,
 updated_by uuid not null references auth.users(id),
 updated_at timestamptz not null default now(),
 primary key(team_id,offer_id),
 foreign key(offer_id,team_id) references public.team_launch_offers(id,team_id) on delete cascade
);
alter table public.team_launch_offer_defaults enable row level security;
alter table public.team_launch_offer_defaults force row level security;
revoke all on public.team_launch_offer_defaults from public,anon,authenticated;
grant select,insert,update,delete on public.team_launch_offer_defaults to service_role;
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
  if jsonb_array_length(new.sub_config->k)>4 or exists(select 1 from jsonb_array_elements(new.sub_config->k) x where jsonb_typeof(x) is distinct from 'string' or x#>>'{}' not in('buyer','social','adAccountSuffix','creative')) or (select count(*)<>count(distinct x) from jsonb_array_elements(new.sub_config->k) x) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 return new;
end $$;

create trigger team_launch_offer_defaults_validate before insert or update on public.team_launch_offer_defaults for each row execute function private.validate_launch_defaults_row();
create trigger team_launch_offer_defaults_invalidate after insert or update or delete on public.team_launch_offer_defaults for each row execute function private.launch_workspace_invalidate();

create function public.get_launch_offer_defaults(p_team uuid,p_offer uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 perform private.launch_access(p_team,'view');
 if not exists(select 1 from public.team_launch_offers where team_id=p_team and id=p_offer and archived_at is null) then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 return (select jsonb_build_object('config',config,'subConfig',sub_config,'version',version::text) from public.team_launch_offer_defaults where team_id=p_team and offer_id=p_offer);
end $$;

create function private.save_launch_defaults(p_team uuid,p_offer uuid,p_expected_version text,p_key text,p_config jsonb,p_sub_config jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare previous_version bigint;next_version bigint;result jsonb;replay jsonb;payload jsonb:=jsonb_build_array(p_offer,p_expected_version,p_config,p_sub_config);action text:=case when p_offer is null then 'defaults' else 'offer-defaults' end;
begin
 perform private.launch_access(p_team,'manage_metadata');
 -- Preserve legacy request digests so an older client can safely replay its write.
 if p_offer is null then payload:=jsonb_build_array(p_expected_version,p_config,p_sub_config);end if;
 if p_offer is not null then
  perform 1 from public.team_launch_offers where team_id=p_team and id=p_offer and archived_at is null for share;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 end if;
 replay:=private.launch_request(p_team,p_key,action,payload);if replay is not null then return replay;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text||'launch-defaults'||coalesce(p_offer::text,''),0));
 if p_offer is null then select version into previous_version from public.team_launch_defaults where team_id=p_team for update;
 else select version into previous_version from public.team_launch_offer_defaults where team_id=p_team and offer_id=p_offer for update;end if;
 -- Validate before conflict reporting, including for malformed legacy clients.
 if jsonb_typeof(p_config) is distinct from 'object' or jsonb_typeof(p_sub_config) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_config) k where k not in('buyerId','campaignCount','minBudget','maxBudget','adsCount','age','gender','method','advantagePlus','catalog','budgetMode','budgets')) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if p_config ? 'budgets' and p_config->'budgets'<>'null'::jsonb and p_config->>'budgetMode' is distinct from 'manual' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if p_config ? 'buyerId' and not exists(select 1 from public.team_launch_buyers where team_id=p_team and id::text=p_config->>'buyerId' and archived_at is null) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if previous_version::text is distinct from p_expected_version then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 if p_offer is null then
  insert into public.team_launch_defaults(team_id,config,sub_config,updated_by) values(p_team,p_config,p_sub_config,auth.uid()) on conflict(team_id) do update set config=excluded.config,sub_config=excluded.sub_config,version=team_launch_defaults.version+1,updated_by=auth.uid(),updated_at=clock_timestamp() returning version into next_version;
 else
  insert into public.team_launch_offer_defaults(team_id,offer_id,config,sub_config,updated_by) values(p_team,p_offer,p_config,p_sub_config,auth.uid()) on conflict(team_id,offer_id) do update set config=excluded.config,sub_config=excluded.sub_config,version=team_launch_offer_defaults.version+1,updated_by=auth.uid(),updated_at=clock_timestamp() returning version into next_version;
 end if;
 result:=jsonb_build_object('version',next_version::text);perform private.launch_remember(p_team,p_key,action,payload,result);return result;
end $$;
create or replace function public.set_launch_defaults(p_team uuid,p_expected_version text,p_key text,p_config jsonb,p_sub_config jsonb) returns jsonb language sql security definer set search_path='' as $$
 select private.save_launch_defaults(p_team,null,p_expected_version,p_key,p_config,p_sub_config);
$$;
create function public.set_launch_offer_defaults(p_team uuid,p_offer uuid,p_expected_version text,p_key text,p_config jsonb,p_sub_config jsonb) returns jsonb language plpgsql security definer set search_path='' as $$ begin
 if p_offer is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 return private.save_launch_defaults(p_team,p_offer,p_expected_version,p_key,p_config,p_sub_config);
end $$;
revoke all on function private.save_launch_defaults(uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.get_launch_offer_defaults(uuid,uuid),public.set_launch_offer_defaults(uuid,uuid,text,text,jsonb,jsonb) from public,anon;
grant execute on function public.get_launch_offer_defaults(uuid,uuid),public.set_launch_offer_defaults(uuid,uuid,text,text,jsonb,jsonb) to authenticated;
