begin;
-- Weekly replacement is server work, not a browser timer. Disabled until explicitly saved.
create table private.catalog_text_schedule (
 team_id uuid primary key references public.teams(id) on delete cascade,
 enabled boolean not null default false,
 text_count integer not null default 200 check(text_count between 1 and 1000),
 revision bigint not null default 1,
 content_revision bigint not null default 0,
 configured_by uuid references auth.users(id) on delete set null,
 next_run_at timestamptz,
 next_attempt_at timestamptz,
 last_run_at timestamptz,
 last_error text check(last_error in('READ_FAILED','SAVE_FAILED','VALIDATION','CONFLICT','PERMISSION_DENIED')),
 run_id uuid,
 lease_token uuid,
 lease_until timestamptz,
 claimed_revision bigint,
 claimed_content_revision bigint,
 attempts integer not null default 0,
 updated_at timestamptz not null default clock_timestamp()
);
create index catalog_text_schedule_due on private.catalog_text_schedule(next_attempt_at) where enabled;
create table private.catalog_text_schedule_journal (
 seq bigint generated always as identity primary key,
 team_id uuid not null references public.teams(id) on delete cascade,
 run_id uuid,
 stage text not null check(stage in('configured','claimed','lease_recovered','committed','failed','cancelled')),
 code text check(code in('READ_FAILED','SAVE_FAILED','VALIDATION','CONFLICT','PERMISSION_DENIED')),
 schedule_revision bigint not null,
 text_count integer not null check(text_count between 1 and 1000),
 occurred_at timestamptz not null default clock_timestamp()
);
create index catalog_text_schedule_journal_run on private.catalog_text_schedule_journal(run_id,stage);
alter table private.catalog_text_schedule enable row level security;
alter table private.catalog_text_schedule_journal enable row level security;
revoke all on private.catalog_text_schedule,private.catalog_text_schedule_journal from public,anon,authenticated,service_role;

create function private.catalog_text_schedule_json(p_team uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('enabled',coalesce(s.enabled,false),'count',coalesce(s.text_count,200),
 'nextRunAt',s.next_run_at,'lastRunAt',s.last_run_at,'lastError',s.last_error)
 from (select 1) seed left join private.catalog_text_schedule s on s.team_id=p_team
$$;
create function public.get_team_product_catalog_text_schedule(p_team uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.can(p_team,'view',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 return private.catalog_text_schedule_json(p_team);
end $$;
create function public.set_team_product_catalog_text_schedule(p_team uuid,p_enabled boolean,p_count integer default 200) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.catalog_text_schedule; at timestamptz:=clock_timestamp();
begin
 if auth.uid() is null or not private.can(p_team,'manage_metadata',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if p_enabled is null or p_count is null or p_count not between 1 and 1000 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 insert into private.catalog_text_schedule(team_id,configured_by) values(p_team,auth.uid()) on conflict do nothing;
 select * into s from private.catalog_text_schedule where team_id=p_team for update;
 if s.enabled=p_enabled and s.text_count=p_count and s.configured_by is not null then return private.catalog_text_schedule_json(p_team); end if;
 if s.run_id is not null then
  insert into private.catalog_text_schedule_journal(team_id,run_id,stage,schedule_revision,text_count)
  values(p_team,s.run_id,'cancelled',s.revision,s.text_count);
 end if;
 update private.catalog_text_schedule set enabled=p_enabled,text_count=p_count,revision=revision+1,
 configured_by=auth.uid(),next_run_at=case when not p_enabled then null when s.enabled then s.next_run_at else at+interval '7 days' end,
 next_attempt_at=case when not p_enabled then null when s.enabled then s.next_run_at else at+interval '7 days' end,
 run_id=null,lease_token=null,lease_until=null,claimed_revision=null,claimed_content_revision=null,
 attempts=0,last_error=null,updated_at=at where team_id=p_team returning * into s;
 insert into private.catalog_text_schedule_journal(team_id,stage,schedule_revision,text_count)
 values(p_team,'configured',s.revision,s.text_count);
 return private.catalog_text_schedule_json(p_team);
end $$;

-- Manual edits participate in the same row lock. A schedule cannot commit a stale read
-- over an intervening manual replacement/edit. Automatic writes increment this too.
create function private.catalog_text_content_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 update private.catalog_text_schedule set content_revision=content_revision+1
 where team_id=case when TG_OP='DELETE' then old.team_id else new.team_id end;
 return null;
end $$;
create trigger catalog_text_content_changed after insert or update or delete on public.team_product_catalog_texts
for each row execute function private.catalog_text_content_changed();

-- Preserve manual mutation semantics while serializing before row-level text locks.
create or replace function public.replace_team_product_catalog_texts(p_team uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  pos integer := 0;
begin
  if auth.uid() is null or not private.can(p_team, 'manage_metadata', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- Match automatic commit lock order before taking any text-row locks.
  perform 1 from private.catalog_text_schedule where team_id=p_team for update;
  delete from public.team_product_catalog_texts where team_id = p_team;
  delete from private.product_catalog_draws where team_id = p_team and pool = 'text';
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item -> 'title') <> 'string' or jsonb_typeof(item -> 'description') <> 'string'
       or char_length(btrim(item ->> 'title')) not between 1 and 200
       or char_length(btrim(item ->> 'description')) not between 1 and 9999 then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    pos := pos + 1;
    insert into public.team_product_catalog_texts (team_id, position, title, description)
    values (p_team, pos, btrim(item ->> 'title'), btrim(item ->> 'description'));
  end loop;
  return pos;
end;
$$;

create or replace function public.update_team_product_catalog_text(
  p_team uuid, p_id uuid, p_title text, p_description text
)
returns public.team_product_catalog_texts
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.team_product_catalog_texts;
begin
  if auth.uid() is null or not private.can(p_team, 'manage_metadata', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 200
     or char_length(btrim(coalesce(p_description, ''))) not between 1 and 9999 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- Match automatic commit lock order before taking any text-row locks.
  perform 1 from private.catalog_text_schedule where team_id=p_team for update;
  update public.team_product_catalog_texts
  set title = btrim(p_title), description = btrim(p_description), updated_at = now()
  where id = p_id and team_id = p_team
  returning * into saved;
  if saved.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return saved;
end;
$$;


create function private.catalog_text_schedule_due() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.catalog_text_schedule s where s.enabled
 and s.next_attempt_at<=clock_timestamp() and (s.lease_until is null or s.lease_until<=clock_timestamp()))
$$;
create function public.service_claim_catalog_text_schedule(p_limit integer default 2) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.catalog_text_schedule; result jsonb:='[]'; at timestamptz:=clock_timestamp(); recovered boolean;
begin
 for s in select * from private.catalog_text_schedule where enabled and next_attempt_at<=at
  and (lease_until is null or lease_until<=at) order by next_attempt_at,team_id
  for update skip locked limit least(greatest(p_limit,1),2)
 loop
  if private.can(s.team_id,'manage_metadata',s.configured_by) is distinct from true then
   update private.catalog_text_schedule set enabled=false,next_run_at=null,next_attempt_at=null,last_error='PERMISSION_DENIED',lease_token=null,lease_until=null where team_id=s.team_id;
   insert into private.catalog_text_schedule_journal(team_id,run_id,stage,code,schedule_revision,text_count)
   values(s.team_id,s.run_id,'failed','PERMISSION_DENIED',s.revision,s.text_count);
   continue;
  end if;
  recovered:=s.lease_token is not null;
  update private.catalog_text_schedule set run_id=coalesce(run_id,gen_random_uuid()),lease_token=gen_random_uuid(),
   lease_until=at+interval '2 minutes',claimed_revision=revision,claimed_content_revision=content_revision,attempts=attempts+1
   where team_id=s.team_id returning * into s;
  insert into private.catalog_text_schedule_journal(team_id,run_id,stage,schedule_revision,text_count)
  values(s.team_id,s.run_id,case when recovered then 'lease_recovered' else 'claimed' end,s.revision,s.text_count);
  result:=result||jsonb_build_array(jsonb_build_object('teamId',s.team_id,'runId',s.run_id,'leaseToken',s.lease_token,'count',s.text_count));
 end loop;
 return result;
end $$;

-- Read only generator inputs; the journal stores none of these names or generated content.
create function public.service_catalog_text_schedule_inputs(p_team uuid,p_run uuid,p_lease uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from private.catalog_text_schedule where team_id=p_team and enabled and run_id=p_run and lease_token=p_lease and lease_until>clock_timestamp()) then raise exception 'CONFLICT'; end if;
 if public.service_catalog_image_mode_v2(p_team)='v2' then
  return jsonb_build_object('mode','v2','pairs',coalesce((select jsonb_agg(jsonb_build_object('garment',x.garment,'color',x.color)) from (
   select distinct e.classification->>'garment' garment,e.classification->>'color' color
   from public.team_catalog_image_pool_entries e join private.catalog_image_publications p on p.id=e.publication_id
   where e.team_id=p_team and e.active and p.state='ready' and e.classification->>'mode'='matched' limit 1000) x),'[]'::jsonb));
 end if;
 return jsonb_build_object('mode','legacy','names',coalesce((select jsonb_agg(x.name) from (select name from private.product_catalog_pool_images(p_team) limit 5000) x),'[]'::jsonb));
end $$;

create function public.service_commit_catalog_text_schedule(p_team uuid,p_run uuid,p_lease uuid,p_items jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare s private.catalog_text_schedule; item jsonb; pos integer:=0; at timestamptz:=clock_timestamp();
begin
 if p_run is null or p_lease is null then return false; end if;
 select * into s from private.catalog_text_schedule where team_id=p_team for update;
 -- Replay of a lost commit reply is read-only, even after a later configuration change.
 if exists(select 1 from private.catalog_text_schedule_journal where team_id=p_team and run_id=p_run and stage='committed') then return true; end if;
 if p_run is null or p_lease is null or s.run_id is null or s.lease_token is null or s.lease_until is null
 or s.team_id is null or not s.enabled or s.run_id is distinct from p_run or s.lease_token is distinct from p_lease or s.lease_until<=at
 or s.revision<>s.claimed_revision or s.content_revision<>s.claimed_content_revision then return false; end if;
 if private.can(p_team,'manage_metadata',s.configured_by) is distinct from true then return false; end if;
 if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<>s.text_count then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 for item in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(item->'title') is distinct from 'string' or jsonb_typeof(item->'description') is distinct from 'string'
   or char_length(btrim(item->>'title')) not between 1 and 200 or char_length(btrim(item->>'description')) not between 1 and 9999 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 end loop;
 -- Single transaction: a failed insert leaves both the previous pool and draw state intact.
 delete from public.team_product_catalog_texts where team_id=p_team;
 delete from private.product_catalog_draws where team_id=p_team and pool='text';
 for item in select value from jsonb_array_elements(p_items) loop
  pos:=pos+1;
  insert into public.team_product_catalog_texts(team_id,position,title,description) values(p_team,pos,btrim(item->>'title'),btrim(item->>'description'));
 end loop;
 insert into private.catalog_text_schedule_journal(team_id,run_id,stage,schedule_revision,text_count)
 values(p_team,p_run,'committed',s.revision,s.text_count);
 update private.catalog_text_schedule set last_run_at=at,last_error=null,next_run_at=at+interval '7 days',next_attempt_at=at+interval '7 days',
 run_id=null,lease_token=null,lease_until=null,claimed_revision=null,claimed_content_revision=null,attempts=0,updated_at=at where team_id=p_team;
 return true;
end $$;
create function public.service_fail_catalog_text_schedule(p_team uuid,p_run uuid,p_lease uuid,p_code text) returns boolean
language plpgsql security definer set search_path='' as $$
declare s private.catalog_text_schedule;
begin
 if p_code is null or p_code not in('READ_FAILED','SAVE_FAILED','VALIDATION','CONFLICT','PERMISSION_DENIED') then raise exception 'INVALID_INPUT'; end if;
 select * into s from private.catalog_text_schedule where team_id=p_team for update;
 if p_run is null or p_lease is null or s.team_id is null or s.run_id is null or s.lease_token is null or s.lease_until is null
 or not s.enabled or s.run_id is distinct from p_run or s.lease_token is distinct from p_lease or s.lease_until<=clock_timestamp() then return false; end if;
 insert into private.catalog_text_schedule_journal(team_id,run_id,stage,code,schedule_revision,text_count)
 values(p_team,p_run,'failed',p_code,s.revision,s.text_count);
 update private.catalog_text_schedule set last_error=p_code,lease_token=null,lease_until=null,
 next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,60*greatest(1,attempts))),updated_at=clock_timestamp() where team_id=p_team;
 return true;
end $$;

revoke all on function private.catalog_text_schedule_json(uuid),private.catalog_text_content_changed(),private.catalog_text_schedule_due(),
 public.get_team_product_catalog_text_schedule(uuid),public.set_team_product_catalog_text_schedule(uuid,boolean,integer),
 public.service_claim_catalog_text_schedule(integer),public.service_catalog_text_schedule_inputs(uuid,uuid,uuid),
 public.service_commit_catalog_text_schedule(uuid,uuid,uuid,jsonb),public.service_fail_catalog_text_schedule(uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role;
grant execute on function public.get_team_product_catalog_text_schedule(uuid),public.set_team_product_catalog_text_schedule(uuid,boolean,integer) to authenticated;
grant execute on function public.service_claim_catalog_text_schedule(integer),public.service_catalog_text_schedule_inputs(uuid,uuid,uuid),
 public.service_commit_catalog_text_schedule(uuid,uuid,uuid,jsonb),public.service_fail_catalog_text_schedule(uuid,uuid,uuid,text) to service_role;

create view public.analytics_catalog_text_schedule with(security_invoker=false) as
 select team_id,enabled,text_count,revision,next_run_at,next_attempt_at,last_run_at,last_error,run_id,lease_until,attempts,updated_at from private.catalog_text_schedule;
create view public.analytics_catalog_text_schedule_journal with(security_invoker=false) as
 select seq::text evidence_id,team_id,run_id,stage,code,schedule_revision,text_count,occurred_at from private.catalog_text_schedule_journal;
revoke all on public.analytics_catalog_text_schedule,public.analytics_catalog_text_schedule_journal from public,anon,authenticated,service_role;
do $$ begin
 if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then grant select on public.analytics_catalog_text_schedule,public.analytics_catalog_text_schedule_journal to wishly_analytics_ro; end if;
end $$;
-- Bounded diagnostic retention. Keep committed receipts for the recent seven-day cycle and
-- longer than lease/retry windows; older run tokens cannot match a current schedule lease.
create function private.prune_catalog_text_schedule_journal() returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 with old as(select seq from private.catalog_text_schedule_journal where occurred_at<clock_timestamp()-interval '30 days' order by seq limit 1000)
 delete from private.catalog_text_schedule_journal j using old where j.seq=old.seq;
 get diagnostics n=row_count; return n;
end $$;
revoke all on function private.prune_catalog_text_schedule_journal() from public,anon,authenticated,service_role;
select cron.schedule('catalog-text-diagnostics-retention','17 * * * *','select private.prune_catalog_text_schedule_journal()');

create table private.catalog_text_schedule_capture (
 singleton boolean primary key default true check(singleton),
 installed_at timestamptz not null default clock_timestamp()
);
insert into private.catalog_text_schedule_capture(singleton) values(true);
alter table private.catalog_text_schedule_capture enable row level security;
revoke all on private.catalog_text_schedule_capture from public,anon,authenticated,service_role;
create view public.analytics_catalog_text_schedule_coverage with(security_invoker=false) as
 select installed_at,1 as schema_version,
  (to_regprocedure('public.service_commit_catalog_text_schedule(uuid,uuid,uuid,jsonb)') is not null
   and exists(select 1 from cron.job where jobname='wishly-catalog-updater' and active)
   and exists(select 1 from pg_trigger where tgname='catalog_text_content_changed' and tgenabled<>'D')) as capture_enabled
 from private.catalog_text_schedule_capture;
revoke all on public.analytics_catalog_text_schedule_coverage from public,anon,authenticated,service_role;
do $$ begin
 if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then grant select on public.analytics_catalog_text_schedule_coverage to wishly_analytics_ro; end if;
end $$;

-- Match the platform's conservative catalog metadata reference inventory.
do $$ declare t record; begin
 for t in select * from private.task_cleanup_reference_tables()
  where table_name in ('catalog_text_schedule','catalog_text_schedule_journal','catalog_text_schedule_capture') loop
  execute format('create trigger task_cleanup_reference_fence before insert or update on %I.%I for each row execute function private.guard_task_cleanup_reference()',t.schema_name,t.table_name);
 end loop;
end $$;

-- Retain every existing dispatch lane and wake due text schedules even without catalogs.
create or replace function private.invoke_catalog_updater_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  worker_secret text;
  request_id bigint;
  recovery_due boolean := private.launch_catalog_recovery_due();
  process_work_due boolean := private.process_output_cleanup_due();
  launch_work_due boolean := private.catalog_text_schedule_due() or private.launch_settlement_due() or private.launch_cleanup_due() or recovery_due or process_work_due or exists(select 1 from private.task_attachment_cleanup where state in ('waiting','claimed') and not_before<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp()));
  recovery_endpoint text;
begin
  begin
    perform private.retire_unused_restitch_copies();
  exception when others then
    -- Housekeeping must not prevent dispatch of accepted work.
    null;
  end;

  if not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.update_interval is not null and item.next_run_at <= clock_timestamp()
      and item.round_due_at is null and not item.reconciliation_required
  ) and not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.round_due_at is not null and item.next_attempt_at <= clock_timestamp()
      and not item.reconciliation_required
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
  ) and not exists (
    select 1 from private.catalog_update_reconciliations as pending
    where pending.next_check_at <= clock_timestamp()
  ) and not exists (
    select 1 from public.team_catalog_restitch_copies as copy
    where copy.role = 'retired' and copy.next_delete_at <= clock_timestamp()
  ) and not launch_work_due then
    return null;
  end if;

  if (select count(*) from public.team_catalog_updater_items
      where lease_expires_at > clock_timestamp()) >= 12
      and not launch_work_due then
    return null;
  end if;

  select private.catalog_updater_endpoint(secret.decrypted_secret) into endpoint
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_secret'
  order by secret.created_at desc limit 1;
  if endpoint is null or worker_secret is null or char_length(worker_secret) < 32 then
    return null;
  end if;

  if recovery_due then
    recovery_endpoint := regexp_replace(endpoint, '/catalog-updater$', '/drive-ops/launches/recover');
    if recovery_endpoint <> endpoint then
      perform net.http_post(
        url := recovery_endpoint,
        headers := pg_catalog.jsonb_build_object('content-type', 'application/json',
          'x-catalog-sync-secret', worker_secret),
        body := '{}'::jsonb, timeout_milliseconds := 60000
      );
    end if;
  end if;

  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object('content-type', 'application/json',
      'x-catalog-sync-secret', worker_secret),
    body := '{"scheduled":true}'::jsonb, timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end;
$$;

commit;
