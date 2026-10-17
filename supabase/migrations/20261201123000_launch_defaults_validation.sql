-- Validate partial workspace defaults at the storage boundary as well as in the browser.
create function private.validate_launch_defaults_row() returns trigger language plpgsql security definer set search_path='' as $$
declare k text;v jsonb;limit_value numeric;c jsonb;begin
 if jsonb_typeof(new.config) is distinct from 'object' or jsonb_typeof(new.sub_config) is distinct from 'object' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for k,v in select key,value from jsonb_each(new.config) loop
  if k not in('buyerId','campaignCount','maxBudget','adsCount','age','gender','method','advantagePlus','catalog') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if k in('campaignCount','maxBudget','adsCount','age') then
   limit_value:=case k when 'campaignCount' then 100 when 'maxBudget' then 999999 when 'adsCount' then 1000 else 9007199254740991 end;
   if jsonb_typeof(v) is distinct from 'number' or v::text !~ '^[0-9]+$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if (v::text)::numeric not between 1 and limit_value then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  elsif k='gender' and v#>>'{}' not in('M','W','ALL') or k='method' and v#>>'{}' not in('catalog','other') or k='advantagePlus' and jsonb_typeof(v) is distinct from 'boolean' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 if new.config ? 'gender' and jsonb_typeof(new.config->'gender') is distinct from 'string' or new.config ? 'method' and jsonb_typeof(new.config->'method') is distinct from 'string' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if new.config ? 'buyerId' and (jsonb_typeof(new.config->'buyerId') is distinct from 'string' or not exists(select 1 from public.team_launch_buyers where team_id=new.team_id and id::text=new.config->>'buyerId' and archived_at is null)) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 c:=new.config->'catalog';
 if c is not null then
  if jsonb_typeof(c) is distinct from 'object' or jsonb_typeof(c->'productCount') is distinct from 'number' or c->>'productCount' !~ '^[0-9]+$' or jsonb_typeof(c->'restitchEnabled') is distinct from 'boolean' or jsonb_typeof(c->'finalDurationMode') is distinct from 'string' or c->>'finalDurationMode' not in('random-30-40','random-40-50','random-50-60','custom') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if (c->>'productCount')::numeric not between 1 and 400 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if c->'customFinalDurationSeconds' is distinct from 'null'::jsonb then
   if jsonb_typeof(c->'customFinalDurationSeconds') is distinct from 'number' or c->>'customFinalDurationSeconds' !~ '^[0-9]+$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if (c->>'customFinalDurationSeconds')::numeric not between 60 and 3600 or mod((c->>'customFinalDurationSeconds')::numeric,60)<>0 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  elsif c->>'finalDurationMode'='custom' and c->>'restitchEnabled'='true' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end if;
 if new.sub_config->'schemaVersion' is distinct from '1'::jsonb then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for k in select unnest(array['sub1','sub2','sub3']) loop
  if jsonb_typeof(new.sub_config->k) is distinct from 'array' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if jsonb_array_length(new.sub_config->k)>4 or exists(select 1 from jsonb_array_elements(new.sub_config->k) x where jsonb_typeof(x) is distinct from 'string' or x#>>'{}' not in('buyer','social','adAccountSuffix','creative')) or (select count(*)<>count(distinct x) from jsonb_array_elements(new.sub_config->k) x) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 return new;
end $$;
revoke all on function private.validate_launch_defaults_row() from public,anon,authenticated;
create trigger team_launch_defaults_validate before insert or update on public.team_launch_defaults for each row execute function private.validate_launch_defaults_row();
