-- Optional note colors reuse the seven file markers. Existing notes are unchanged.
create or replace function private.launch_notes_valid(p_notes jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare n jsonb;ids text[]:=array[]::text[];begin
 if jsonb_typeof(p_notes) is distinct from 'array' then return false;end if;
 for n in select value from jsonb_array_elements(p_notes) loop
  if jsonb_typeof(n) is distinct from 'object' then return false;end if;
  if exists(select 1 from jsonb_object_keys(n) k where k not in('id','title','text','color'))
   or jsonb_typeof(n->'id') is distinct from 'string' or n->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   or n->>'id'=any(ids) or jsonb_typeof(n->'title') is distinct from 'string' or char_length(n->>'title')>160
   or jsonb_typeof(n->'text') is distinct from 'string' or char_length(n->>'text')>8192 then return false;end if;
  if n ? 'color' and n->'color'<>'null'::jsonb and
   (jsonb_typeof(n->'color') is distinct from 'string' or n->>'color' not in('red','orange','yellow','green','blue','purple','grey')) then return false;end if;
  ids:=array_append(ids,n->>'id');
 end loop;
 return true;
end $$;
revoke all on function private.launch_notes_valid(jsonb) from public,anon,authenticated,service_role;
