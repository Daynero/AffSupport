-- Forward correction: keep dictionary RPC normalization in parity with shared validators.
create or replace function public.create_launch_dictionary(p_team uuid,p_kind text,p_value text,p_request_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v text;k text;payload jsonb:=jsonb_build_array(p_kind,p_value);replay jsonb;result jsonb;
begin
 perform private.launch_access(p_team,'manage_metadata');replay:=private.launch_request(p_team,p_request_key,'dictionary-create',payload);if replay is not null then return replay;end if;
 -- Match the shared Zs-only SUB normalization; tabs and controls are invalid.
 v:=normalize(p_value,NFC);
 if p_kind='buyers' then
  v:=btrim(v,U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000');
 else
  v:=btrim(v,U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
 end if;
 if p_kind='buyers' then v:=regexp_replace(v,U&'[\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000]+','_','g');if char_length(v) not between 1 and 80 or v !~ '^[A-Za-z0-9_-]+$' then raise exception 'LAUNCH_SUB_INVALID' using errcode='22023';end if;
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
