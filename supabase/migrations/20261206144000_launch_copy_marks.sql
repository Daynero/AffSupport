-- Personal clipboard receipts. Never persist the copied text or a guessable plain hash.
create table private.launch_copy_keys (
 user_id uuid primary key references auth.users(id) on delete cascade,
 secret bytea not null default extensions.gen_random_bytes(32) check(octet_length(secret)=32)
);
create table private.launch_copy_marks (
 user_id uuid not null references auth.users(id) on delete cascade,
 team_id uuid not null,
 launch_id uuid not null,
 baseline_revision_id uuid,
 field text not null,
 fingerprint bytea not null check(octet_length(fingerprint)=32),
 copied_at timestamptz not null default clock_timestamp(),
 foreign key(launch_id,team_id) references public.team_launches(id,team_id) on delete cascade,
 foreign key(baseline_revision_id,launch_id,team_id) references public.team_launch_revisions(id,launch_id,team_id) on delete cascade,
 unique nulls not distinct(user_id,team_id,launch_id,baseline_revision_id,field,fingerprint)
);
alter table private.launch_copy_keys enable row level security;
alter table private.launch_copy_keys force row level security;
alter table private.launch_copy_marks enable row level security;
alter table private.launch_copy_marks force row level security;
revoke all on private.launch_copy_keys,private.launch_copy_marks from public,anon,authenticated,service_role;

create function private.launch_copy_scope(p_team uuid,p_launch uuid,p_revision uuid,p_actor uuid,p_values jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare baseline uuid;begin
 if auth.uid() is null or auth.uid() is distinct from p_actor then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 perform private.launch_access(p_team,'view');
 select coalesce(r.baseline_revision_id,r.id) into baseline from public.team_launch_revisions r join public.team_launches l on l.id=r.launch_id and l.team_id=r.team_id
 where r.id=p_revision and r.launch_id=p_launch and r.team_id=p_team and l.archived_at is null;
 if baseline is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if jsonb_typeof(p_values) is distinct from 'object' or octet_length(p_values::text)>262144 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if (select count(*) from jsonb_object_keys(p_values))>2048 or exists(
  select 1 from jsonb_each(p_values) v where
   (v.key not in('catalog_name','catalog_url','advertising_url') and v.key !~ '^campaign:([1-9][0-9]?|100)$' and v.key !~* '^note:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
   or jsonb_typeof(v.value) is distinct from 'string' or char_length(v.value#>>'{}') not between 1 and 8192
 ) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 return baseline;
end $$;
revoke all on function private.launch_copy_scope(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;

create function public.get_launch_copy_marks(p_team uuid,p_launch uuid,p_revision uuid,p_actor uuid,p_values jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare baseline uuid;k bytea;result jsonb;begin
 baseline:=private.launch_copy_scope(p_team,p_launch,p_revision,p_actor,p_values);
 select secret into k from private.launch_copy_keys where user_id=auth.uid();
 if k is null then return '[]'::jsonb;end if;
 select coalesce(jsonb_agg(v.key order by v.key),'[]'::jsonb) into result
 from jsonb_each_text(p_values) v join private.launch_copy_marks m
  on m.user_id=auth.uid() and m.team_id=p_team and m.launch_id=p_launch and m.field=v.key
  and m.baseline_revision_id is not distinct from case when v.key like 'note:%' then null::uuid else baseline end
  and m.fingerprint=extensions.hmac(convert_to(v.key||chr(31)||v.value,'UTF8'),k,'sha256');
 return result;
end $$;
create function public.set_launch_copy_marks(p_team uuid,p_launch uuid,p_revision uuid,p_actor uuid,p_values jsonb,p_copied boolean) returns void language plpgsql security definer set search_path='' as $$
declare baseline uuid;k bytea;f text;v text;scope uuid;begin
 baseline:=private.launch_copy_scope(p_team,p_launch,p_revision,p_actor,p_values);
 if p_copied is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 -- One personal stream makes copy/reset/undo deterministic across tabs.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text||':launch-copy:'||p_launch::text,0));
 if p_copied then
  insert into private.launch_copy_keys(user_id) values(auth.uid()) on conflict do nothing;
 end if;
 select secret into k from private.launch_copy_keys where user_id=auth.uid();
 for f,v in select key,value from jsonb_each_text(p_values) loop
  scope:=case when f like 'note:%' then null::uuid else baseline end;
  if p_copied then
   insert into private.launch_copy_marks(user_id,team_id,launch_id,baseline_revision_id,field,fingerprint)
   values(auth.uid(),p_team,p_launch,scope,f,extensions.hmac(convert_to(f||chr(31)||v,'UTF8'),k,'sha256'))
   on conflict(user_id,team_id,launch_id,baseline_revision_id,field,fingerprint) do update set copied_at=clock_timestamp();
  else
   delete from private.launch_copy_marks where user_id=auth.uid() and team_id=p_team and launch_id=p_launch and baseline_revision_id is not distinct from scope and field=f and fingerprint=extensions.hmac(convert_to(f||chr(31)||v,'UTF8'),k,'sha256');
  end if;
 end loop;
end $$;
revoke all on function public.get_launch_copy_marks(uuid,uuid,uuid,uuid,jsonb),public.set_launch_copy_marks(uuid,uuid,uuid,uuid,jsonb,boolean) from public,anon;
grant execute on function public.get_launch_copy_marks(uuid,uuid,uuid,uuid,jsonb),public.set_launch_copy_marks(uuid,uuid,uuid,uuid,jsonb,boolean) to authenticated;

-- These new Launch tables are part of conservative cleanup discovery. Preserve
-- the shared reference fence, including references added by future columns.
create trigger task_cleanup_reference_fence before insert or update on private.launch_copy_keys
 for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.launch_copy_marks
 for each row execute function private.guard_task_cleanup_reference();
