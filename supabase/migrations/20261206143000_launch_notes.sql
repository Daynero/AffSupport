-- Notes belong to each protected Launch draft and its immutable revision snapshot.
-- There is no note-count limit; the existing bounded draft request is unchanged.
create function private.launch_notes_valid(p_notes jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare n jsonb;ids text[]:=array[]::text[];begin
 if jsonb_typeof(p_notes) is distinct from 'array' then return false;end if;
 for n in select value from jsonb_array_elements(p_notes) loop
  if jsonb_typeof(n) is distinct from 'object' then return false;end if;
  if exists(select 1 from jsonb_object_keys(n) k where k not in('id','title','text'))
   or jsonb_typeof(n->'id') is distinct from 'string' or n->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   or n->>'id'=any(ids) or jsonb_typeof(n->'title') is distinct from 'string' or char_length(n->>'title')>160
   or jsonb_typeof(n->'text') is distinct from 'string' or char_length(n->>'text')>8192 then return false;end if;
  ids:=array_append(ids,n->>'id');
 end loop;
 return true;
end $$;
revoke all on function private.launch_notes_valid(jsonb) from public,anon,authenticated,service_role;
create function private.validate_launch_notes_row() returns trigger language plpgsql security definer set search_path='' as $$
declare cfg jsonb;begin
 if tg_table_name='team_launches' then cfg:=new.draft_config;else cfg:=new.config;end if;
 if cfg ? 'notes' and not private.launch_notes_valid(cfg->'notes') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 return new;
end $$;
revoke all on function private.validate_launch_notes_row() from public,anon,authenticated,service_role;
create trigger launch_draft_notes_validate before insert or update on public.team_launches for each row execute function private.validate_launch_notes_row();
create trigger launch_revision_notes_validate before insert on public.team_launch_revisions for each row execute function private.validate_launch_notes_row();
