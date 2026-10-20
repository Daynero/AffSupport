-- 038: persisted order, independent archive lifecycle and private decoration.
begin;
alter table public.team_accounts add column sort_rank integer not null default 0, add column archived_at timestamptz, add column lifecycle_version bigint not null default 0;
alter table public.team_account_agents add column sort_rank integer not null default 0, add column archived_at timestamptz, add column lifecycle_version bigint not null default 0;
-- Seed once with the UI's natural numeric order; persisted rank wins thereafter.
create function private.account_natural_sort_key(p_text text) returns text language sql immutable set search_path='' as $$
 select coalesce(string_agg(case when part[1] ~ '^\d+$' then lpad(part[1],64,'0') else lower(part[1]) end,'' order by ordinal),'') from regexp_matches(p_text,'(\d+|\D+)','g') with ordinality as parts(part,ordinal);
$$;
revoke all on function private.account_natural_sort_key(text) from public,anon,authenticated;
with ranked as(select id,row_number() over(partition by team_id order by private.account_natural_sort_key(name),id)-1 as rank from public.team_accounts) update public.team_accounts a set sort_rank=r.rank from ranked r where r.id=a.id;
with ranked as(select a.id,row_number() over(partition by account_id order by exists(select 1 from public.team_agent_runs r where r.agent_row_id=a.id),private.account_natural_sort_key(agent_id),a.id)-1 as rank from public.team_account_agents a) update public.team_account_agents a set sort_rank=r.rank from ranked r where r.id=a.id;
create table public.team_account_order_scopes(team_id uuid not null references public.teams on delete cascade,scope text not null check(scope in('socials','agents')),parent_id uuid not null,version bigint not null default 0,primary key(team_id,scope,parent_id));
create table public.team_account_content_revisions(team_id uuid not null references public.teams on delete cascade,entity_kind text not null check(entity_kind in('social','agent')),entity_id uuid not null,finance_revision bigint not null default 0,membership_revision bigint not null default 0,primary key(team_id,entity_kind,entity_id));
create table public.team_account_lifecycle_events(id uuid primary key default gen_random_uuid(),team_id uuid not null references public.teams on delete cascade,entity_kind text not null check(entity_kind in('social','agent')),entity_id uuid not null,archived boolean not null,occurred_at timestamptz not null default clock_timestamp(),actor_id uuid not null references auth.users,request_id uuid not null,version bigint not null,unique(team_id,entity_kind,entity_id,version));
create table public.team_account_parent_history(id uuid primary key default gen_random_uuid(),team_id uuid not null references public.teams on delete cascade,agent_row_id uuid not null,account_id uuid not null,starts_at timestamptz not null,ends_at timestamptz,provenance text not null check(provenance in('observed','baseline_unknown')),check(ends_at is null or ends_at>=starts_at));
create index team_account_parent_history_lookup on public.team_account_parent_history(team_id,agent_row_id,starts_at);
insert into public.team_account_parent_history(team_id,agent_row_id,account_id,starts_at,provenance) select team_id,id,account_id,created_at,case when exists(select 1 from public.team_agent_transfer_events e where e.agent_row_id=a.id) then 'baseline_unknown' else 'observed' end from public.team_account_agents a;
create table public.team_account_preferences(team_id uuid not null references public.teams on delete cascade,user_id uuid not null references auth.users on delete cascade,agent_id uuid not null references public.team_account_agents on delete cascade,name_color integer not null default 0 check(name_color between 0 and 7),version bigint not null default 0,primary key(team_id,user_id,agent_id));
create table public.team_account_mutation_receipts(team_id uuid not null references public.teams on delete cascade,actor_id uuid not null references auth.users,request_id uuid not null,operation_id uuid not null default gen_random_uuid(),payload jsonb not null,result jsonb not null,primary key(team_id,actor_id,request_id));
create table public.team_account_workspace_signals(team_id uuid primary key references public.teams on delete cascade,revision bigint not null default 0,change_kind text not null default 'accounts');
insert into public.team_account_order_scopes(team_id,scope,parent_id) select id,'socials',id from public.teams union all select team_id,'agents',id from public.team_accounts;
insert into public.team_account_content_revisions(team_id,entity_kind,entity_id) select team_id,'social',id from public.team_accounts union all select team_id,'agent',id from public.team_account_agents;
do $$ declare t text;begin foreach t in array array['team_account_order_scopes','team_account_content_revisions','team_account_lifecycle_events','team_account_parent_history','team_account_preferences','team_account_mutation_receipts','team_account_workspace_signals'] loop
 execute format('alter table public.%I enable row level security',t);execute format('alter table public.%I force row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);
 if t<>'team_account_mutation_receipts' then execute format('grant select on public.%I to authenticated',t);execute format('create policy account_workspace_view on public.%I for select to authenticated using(private.can(team_id,''view'',auth.uid())%s)',t,case when t='team_account_preferences' then ' and user_id=auth.uid()' else '' end);end if;
end loop;end $$;
create function private.team_account_effectively_active(p_team uuid,p_agent uuid) returns boolean language sql stable set search_path='' as $$ select exists(select 1 from public.team_account_agents r join public.team_accounts s on s.id=r.account_id where r.team_id=p_team and r.id=p_agent and r.archived_at is null and s.archived_at is null) $$;
create function private.account_workspace_signal() returns trigger language plpgsql security definer set search_path='' as $$ declare t uuid;begin t:=case when tg_op='DELETE' then old.team_id else new.team_id end;if not exists(select 1 from public.teams where id=t) then return null;end if;insert into public.team_account_workspace_signals(team_id,revision,change_kind) values(t,1,'accounts') on conflict(team_id) do update set revision=public.team_account_workspace_signals.revision+1,change_kind='accounts';return null;end $$;
do $$ declare t text;begin foreach t in array array['team_accounts','team_account_agents','team_agent_runs','team_task_agents','team_task_labels','team_labels','team_task_label_links','team_agent_labels','team_agent_finance_values','team_agent_placements','team_account_order_scopes','team_account_lifecycle_events','team_account_preferences'] loop if to_regclass('public.'||t) is not null then execute format('create trigger account_workspace_signal after insert or update or delete on public.%I for each row execute function private.account_workspace_signal()',t);end if;end loop;end $$;
-- All financial entry points pass this table, including clear, undo and legacy imports.
create function private.account_finance_revision() returns trigger language plpgsql security definer set search_path='' as $$ declare a uuid;t uuid;s uuid;begin
 a:=case when tg_op='DELETE' then old.agent_row_id else new.agent_row_id end;t:=case when tg_op='DELETE' then old.team_id else new.team_id end;
 select account_id into s from public.team_account_agents where id=a and team_id=t;if s is null or not exists(select 1 from public.teams where id=t) then return null;end if;
 insert into public.team_account_content_revisions(team_id,entity_kind,entity_id,finance_revision) values(t,'agent',a,1),(t,'social',s,1) on conflict(team_id,entity_kind,entity_id) do update set finance_revision=public.team_account_content_revisions.finance_revision+1;
 return null;end $$;
create trigger account_finance_revision after insert or update or delete on public.team_agent_finance_values for each row execute function private.account_finance_revision();
-- Serialize account topology and lifecycle with finance writers' existing parent/agent locks.
create function private.account_membership_before() returns trigger language plpgsql security definer set search_path='' as $$ declare scope_parent uuid;begin
 if tg_table_name='team_accounts' then scope_parent:=new.team_id;else scope_parent:=new.account_id;end if;
 insert into public.team_account_order_scopes(team_id,scope,parent_id) values(new.team_id,case when tg_table_name='team_accounts' then 'socials' else 'agents' end,scope_parent) on conflict do nothing;
 perform 1 from public.team_account_order_scopes where team_id=new.team_id order by scope,parent_id for update;
 if tg_table_name='team_account_agents' then
 perform 1 from public.team_accounts where team_id=new.team_id and id=new.account_id for update;
 if (tg_op='INSERT' or new.account_id is distinct from old.account_id) and exists(select 1 from public.team_accounts where id=new.account_id and archived_at is not null) then raise exception 'PARENT_ARCHIVED' using errcode='22023';end if;
 end if;
 if tg_table_name='team_accounts' then select coalesce(max(sort_rank)+1,0) into new.sort_rank from public.team_accounts where team_id=new.team_id;return new;end if;
 if tg_op='INSERT' or new.account_id is distinct from old.account_id then
 if tg_table_name='team_accounts' then select coalesce(max(sort_rank)+1,0) into new.sort_rank from public.team_accounts where team_id=new.team_id;else select coalesce(max(sort_rank)+1,0) into new.sort_rank from public.team_account_agents where account_id=new.account_id;end if;
 end if;return new;end $$;
create trigger account_membership_before before insert or update of account_id on public.team_account_agents for each row execute function private.account_membership_before();
create trigger account_membership_before before insert on public.team_accounts for each row execute function private.account_membership_before();
create function private.account_membership_after() returns trigger language plpgsql security definer set search_path='' as $$ declare t uuid;e uuid;s uuid;k text;begin
 t:=case when tg_op='DELETE' then old.team_id else new.team_id end;e:=case when tg_op='DELETE' then old.id else new.id end;k:=case when tg_table_name='team_accounts' then 'social' else 'agent' end;
 if not exists(select 1 from public.teams where id=t) then return null;end if;
 if k='social' then
 update public.team_account_order_scopes set version=version+1 where team_id=t and scope='socials' and parent_id=t;
 insert into public.team_account_order_scopes(team_id,scope,parent_id) values(t,'agents',e) on conflict do nothing;
 insert into public.team_account_content_revisions(team_id,entity_kind,entity_id,membership_revision) values(t,k,e,1) on conflict(team_id,entity_kind,entity_id) do update set membership_revision=public.team_account_content_revisions.membership_revision+1;
 return null;end if;
 if tg_op='UPDATE' then if new.account_id=old.account_id then return null;end if;end if;
 if k='social' then s:=t;else s:=case when tg_op='DELETE' then old.account_id else new.account_id end;end if;
 update public.team_account_order_scopes set version=version+1 where team_id=t and ((scope=case when k='social' then 'socials' else 'agents' end and parent_id=s) or (k='agent' and tg_op='UPDATE' and scope='agents' and parent_id=old.account_id));
 insert into public.team_account_content_revisions(team_id,entity_kind,entity_id,membership_revision) values(t,k,e,1) on conflict(team_id,entity_kind,entity_id) do update set membership_revision=public.team_account_content_revisions.membership_revision+1;
 if k='agent' then
 insert into public.team_account_content_revisions(team_id,entity_kind,entity_id,membership_revision) values(t,'social',s,1) on conflict(team_id,entity_kind,entity_id) do update set membership_revision=public.team_account_content_revisions.membership_revision+1;
 if tg_op='UPDATE' then update public.team_account_content_revisions set membership_revision=membership_revision+1,finance_revision=finance_revision+1 where team_id=t and entity_kind='social' and entity_id=old.account_id;end if;
 if tg_op<>'INSERT' then update public.team_account_parent_history set ends_at=clock_timestamp() where team_id=t and agent_row_id=e and ends_at is null;end if;
 if tg_op<>'DELETE' then insert into public.team_account_parent_history(team_id,agent_row_id,account_id,starts_at,provenance) values(t,e,s,case when tg_op='INSERT' then new.created_at else clock_timestamp() end,'observed');end if;
 end if;return null;end $$;
create trigger account_membership_after after insert or delete or update of account_id on public.team_account_agents for each row execute function private.account_membership_after();
create trigger account_membership_after after insert or delete on public.team_accounts for each row execute function private.account_membership_after();
create function private.account_receipt(p_team uuid,p_request uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$ declare r public.team_account_mutation_receipts%rowtype;begin
 if p_request is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_team::text||auth.uid()::text||p_request::text,0));
 select * into r from public.team_account_mutation_receipts where team_id=p_team and actor_id=auth.uid() and request_id=p_request;
 if found then if r.payload<>p_payload then raise exception 'REQUEST_REPLAY_MISMATCH' using errcode='22023';end if;return r.result;end if;return null;end $$;
create function public.get_team_account_mutation(p_team uuid,p_request_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$begin perform private.finance_access(p_team,'view');return(select result from public.team_account_mutation_receipts where team_id=p_team and actor_id=auth.uid() and request_id=p_request_id);end $$;
create function public.reorder_team_accounts(p_team uuid,p_scope text,p_parent uuid,p_moved uuid,p_anchor uuid,p_relation text,p_expected_version text,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$ declare parent uuid:=case when p_scope='socials' then p_team else p_parent end;v bigint;ids uuid[];next_ids uuid[];idx integer;payload jsonb:=jsonb_build_array('order',p_scope,p_parent,p_moved,p_anchor,p_relation,p_expected_version);r jsonb;begin
 perform private.finance_access(p_team,'edit');r:=private.account_receipt(p_team,p_request_id,payload);if r is not null then return r;end if;
 if p_scope not in('socials','agents') or p_scope is null or p_relation not in('before','after') or p_relation is null or p_moved=p_anchor then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select version into v from public.team_account_order_scopes where team_id=p_team and scope=p_scope and parent_id=parent for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if v::text is distinct from p_expected_version then raise exception 'ACCOUNT_ORDER_CONFLICT' using errcode='40001';end if;
 if p_scope='socials' then select array_agg(id order by sort_rank,id) into ids from public.team_accounts where team_id=p_team;if exists(select 1 from public.team_accounts where team_id=p_team and id in(p_moved,p_anchor) and archived_at is not null) then raise exception 'ACCOUNT_ARCHIVED';end if;
 else select array_agg(id order by sort_rank,id) into ids from public.team_account_agents where team_id=p_team and account_id=parent;if not private.team_account_effectively_active(p_team,p_moved) or not private.team_account_effectively_active(p_team,p_anchor) then raise exception 'ACCOUNT_ARCHIVED';end if;end if;
 if not coalesce(p_moved=any(ids),false) or not coalesce(p_anchor=any(ids),false) then raise exception 'ACCOUNT_SCOPE_CHANGED' using errcode='22023';end if;
 next_ids:=array_remove(ids,p_moved);idx:=array_position(next_ids,p_anchor)-case when p_relation='before' then 1 else 0 end;next_ids:=coalesce(next_ids[1:idx],'{}'::uuid[])||array[p_moved]||coalesce(next_ids[idx+1:cardinality(next_ids)],'{}'::uuid[]);
 if next_ids<>ids then
 if p_scope='socials' then update public.team_accounts a set sort_rank=x.rank-1 from unnest(next_ids) with ordinality x(id,rank) where a.id=x.id;else update public.team_account_agents a set sort_rank=x.rank-1 from unnest(next_ids) with ordinality x(id,rank) where a.id=x.id;end if;
 update public.team_account_order_scopes set version=version+1 where team_id=p_team and scope=p_scope and parent_id=parent returning version into v;end if;
 r:=jsonb_build_object('operationId',gen_random_uuid(),'requestId',p_request_id,'version',v::text,'order',to_jsonb(next_ids));insert into public.team_account_mutation_receipts(team_id,actor_id,request_id,payload,result) values(p_team,auth.uid(),p_request_id,payload,r);return r;end $$;
create function public.get_team_account_archive_preflight(p_team uuid,p_kind text,p_entity uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare a timestamptz;v bigint;parent uuid;pv bigint:=0;pa timestamptz;f bigint:=0;m bigint:=0;n bigint:=0;begin
 perform private.finance_access(p_team,'edit');
 if p_kind='social' then select archived_at,lifecycle_version into a,v from public.team_accounts where team_id=p_team and id=p_entity;select count(*) into n from public.team_account_agents where team_id=p_team and account_id=p_entity;
 elsif p_kind='agent' then select archived_at,lifecycle_version,account_id into a,v,parent from public.team_account_agents where team_id=p_team and id=p_entity;select archived_at,lifecycle_version into pa,pv from public.team_accounts where id=parent and team_id=p_team;
 else raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if v is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select finance_revision,membership_revision into f,m from public.team_account_content_revisions where team_id=p_team and entity_kind=p_kind and entity_id=p_entity;
 return jsonb_build_object('entityId',p_entity,'entityKind',p_kind,'lifecycleVersion',v::text,'token',jsonb_build_array(p_team,p_kind,p_entity,v,coalesce(pv,0),coalesce(f,0),coalesce(m,0))::text,'archivedAt',a,'effectiveArchived',a is not null or pa is not null,'childCount',n);
 end $$;
create function public.set_team_account_archived(p_team uuid,p_kind text,p_entity uuid,p_archived boolean,p_expected_version text,p_preflight_token text,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$ declare payload jsonb:=jsonb_build_array('archive',p_kind,p_entity,p_archived,p_expected_version,p_preflight_token);r jsonb;pre jsonb;parent uuid;v bigint;begin
 perform private.finance_access(p_team,'edit');r:=private.account_receipt(p_team,p_request_id,payload);if r is not null then return r;end if;
 if p_archived is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 perform 1 from public.team_account_order_scopes where team_id=p_team order by scope,parent_id for update;
 if p_kind='agent' then select account_id into parent from public.team_account_agents where id=p_entity and team_id=p_team;else parent:=p_entity;end if;
 perform 1 from public.team_accounts where team_id=p_team and id=parent for update;
 perform 1 from public.team_account_agents where team_id=p_team and (id=p_entity or account_id=p_entity) order by id for update;
 pre:=public.get_team_account_archive_preflight(p_team,p_kind,p_entity);
 if pre->>'lifecycleVersion' is distinct from p_expected_version or (p_archived and pre->>'token' is distinct from p_preflight_token) then raise exception 'ACCOUNT_LIFECYCLE_CONFLICT' using errcode='40001';end if;
 if not p_archived and p_kind='agent' and exists(select 1 from public.team_accounts where id=parent and archived_at is not null) then raise exception 'PARENT_ARCHIVED' using errcode='22023';end if;
 if (pre->>'archivedAt' is not null) is distinct from p_archived then
 if p_kind='social' then update public.team_accounts set archived_at=case when p_archived then clock_timestamp() end,lifecycle_version=lifecycle_version+1 where team_id=p_team and id=p_entity returning lifecycle_version into v;
 else update public.team_account_agents set archived_at=case when p_archived then clock_timestamp() end,lifecycle_version=lifecycle_version+1 where team_id=p_team and id=p_entity returning lifecycle_version into v;end if;
 insert into public.team_account_lifecycle_events(team_id,entity_kind,entity_id,archived,actor_id,request_id,version) values(p_team,p_kind,p_entity,p_archived,auth.uid(),p_request_id,v);
 update public.team_account_order_scopes set version=version+1 where team_id=p_team and (scope='socials' or parent_id=parent or parent_id=p_entity);
 end if;
 r:=public.get_team_account_archive_preflight(p_team,p_kind,p_entity)||jsonb_build_object('operationId',gen_random_uuid(),'requestId',p_request_id);insert into public.team_account_mutation_receipts(team_id,actor_id,request_id,payload,result) values(p_team,auth.uid(),p_request_id,payload,r);return r;end $$;
create function public.set_team_account_name_color(p_team uuid,p_agent uuid,p_color integer,p_expected_version text,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$ declare payload jsonb:=jsonb_build_array('color',p_agent,p_color,p_expected_version);r jsonb;v bigint;begin
 perform private.finance_access(p_team,'view');r:=private.account_receipt(p_team,p_request_id,payload);if r is not null then return r;end if;
 if p_color is null or p_color not between 0 and 7 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if not exists(select 1 from public.team_account_agents where team_id=p_team and id=p_agent) then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 insert into public.team_account_preferences(team_id,user_id,agent_id) values(p_team,auth.uid(),p_agent) on conflict do nothing;
 select version into v from public.team_account_preferences where team_id=p_team and user_id=auth.uid() and agent_id=p_agent for update;
 if v::text is distinct from p_expected_version then raise exception 'ACCOUNT_PREFERENCE_CONFLICT' using errcode='40001';end if;
 update public.team_account_preferences set name_color=p_color,version=version+1 where team_id=p_team and user_id=auth.uid() and agent_id=p_agent returning version into v;
 r:=jsonb_build_object('operationId',gen_random_uuid(),'requestId',p_request_id,'agentId',p_agent,'color',p_color,'version',v::text);insert into public.team_account_mutation_receipts(team_id,actor_id,request_id,payload,result) values(p_team,auth.uid(),p_request_id,payload,r);return r;end $$;
-- Keep the pre-feature projection available internally; old callers receive active sources only.
alter function public.list_team_accounts(uuid) rename to list_team_accounts_legacy_038;
revoke all on function public.list_team_accounts_legacy_038(uuid) from public,anon,authenticated;
create function public.get_team_accounts_overview(p_team uuid,p_from date,p_to date,p_timezone text) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare rows jsonb;begin
 perform private.finance_access(p_team,'view');perform private.finance_today(p_timezone);
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>365 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('sort_rank',a.sort_rank,'archived_at',a.archived_at,'lifecycle_version',a.lifecycle_version::text,'agents',coalesce((select jsonb_agg(private.team_agent_json(r.id)||jsonb_build_object('sort_rank',r.sort_rank,'archived_at',r.archived_at,'lifecycle_version',r.lifecycle_version::text,'name_color',coalesce(pref.name_color,0),'name_color_version',coalesce(pref.version,0)::text) order by r.sort_rank,r.id) from public.team_account_agents r left join public.team_account_preferences pref on pref.team_id=p_team and pref.user_id=auth.uid() and pref.agent_id=r.id where r.team_id=p_team and r.account_id=a.id),'[]')) order by a.sort_rank,a.id),'[]') into rows from public.list_team_accounts_legacy_038(p_team) x join public.team_accounts a on a.id=x.id;
 return jsonb_build_object('schemaVersion',1,'accounts',rows,'socialOrderVersion',coalesce((select version::text from public.team_account_order_scopes where team_id=p_team and scope='socials' and parent_id=p_team),'0'),'agentOrderVersions',coalesce((select jsonb_object_agg(parent_id::text,version::text) from public.team_account_order_scopes where team_id=p_team and scope='agents'),'{}'),'coverage',case when exists(select 1 from public.team_account_parent_history where team_id=p_team and provenance='baseline_unknown') then 'partial' else 'complete' end);
end $$;
create function public.list_team_accounts(p_team uuid) returns table(id uuid,team_id uuid,name text,created_at timestamptz,updated_at timestamptz,agents jsonb,task_count bigint) language plpgsql stable security definer set search_path='' as $$begin
 perform private.finance_access(p_team,'view');
 return query select x.id,x.team_id,x.name,x.created_at,x.updated_at,coalesce((select jsonb_agg(j.value||jsonb_build_object('sort_rank',r.sort_rank,'archived_at',r.archived_at,'lifecycle_version',r.lifecycle_version::text) order by r.sort_rank,r.id) from jsonb_array_elements(x.agents) j(value) join public.team_account_agents r on r.id=(j.value->>'id')::uuid where r.archived_at is null),'[]'),x.task_count from public.list_team_accounts_legacy_038(p_team) x join public.team_accounts a on a.id=x.id where a.archived_at is null order by a.sort_rank,a.id;
end $$;
create function public.list_team_account_archive(p_team uuid,p_cursor text default null,p_limit integer default 50,p_query text default '') returns jsonb language plpgsql stable security definer set search_path='' as $$ declare items jsonb;last_key text;begin
 perform private.finance_access(p_team,'view');if p_limit is null or p_limit<1 or p_limit>100 or length(coalesce(p_query,''))>120 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 with entries as(
 select 'social:'||a.id as key,a.id,'social'::text as kind,a.name as name,a.archived_at,null::uuid as parent_id,false as parent_archived from public.team_accounts a where a.team_id=p_team and a.archived_at is not null
 union all select 'agent:'||r.id,r.id,'agent',a.name||'-'||right(r.agent_id,3),r.archived_at,r.account_id,a.archived_at is not null from public.team_account_agents r join public.team_accounts a on a.id=r.account_id where r.team_id=p_team and (r.archived_at is not null or a.archived_at is not null)
 ), page as(select * from entries where (p_cursor is null or key>p_cursor) and (coalesce(p_query,'')='' or name ilike '%'||replace(replace(replace(p_query,'\','\\'),'%','\%'),'_','\_')||'%') order by key limit p_limit+1)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'entityKind',kind,'name',name,'archivedAt',archived_at,'parentId',parent_id,'parentArchived',parent_archived,'reason',case when archived_at is not null then 'own' else 'parent' end,'canRestore',not parent_archived,'cursor',key) order by key) filter(where row_num<=p_limit),'[]'),case when count(*)>p_limit then max(key) filter(where row_num=p_limit) end into items,last_key from(select page.*,row_number() over(order by key) row_num from page) x;
 return jsonb_build_object('items',items,'next',last_key);end $$;
create function public.get_team_agent_finance_v2(p_team uuid,p_from date,p_to date,p_timezone text) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare result jsonb;begin
 result:=public.get_team_agent_finance(p_team,p_from,p_to,p_timezone);
 return result||jsonb_build_object('schemaVersion',2,'timezone',p_timezone,'lifecycle',jsonb_build_object(
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',id,'createdAt',created_at,'archivedAt',archived_at,'version',lifecycle_version::text,'sortRank',sort_rank)) from public.team_accounts where team_id=p_team),'[]'),
 'agents',coalesce((select jsonb_agg(jsonb_build_object('id',id,'accountId',account_id,'createdAt',created_at,'archivedAt',archived_at,'version',lifecycle_version::text,'sortRank',sort_rank)) from public.team_account_agents where team_id=p_team),'[]'),
 'events',coalesce((select jsonb_agg(jsonb_build_object('entityKind',entity_kind,'entityId',entity_id,'archived',archived,'occurredAt',occurred_at) order by occurred_at,version) from public.team_account_lifecycle_events where team_id=p_team),'[]'),
 'parents',coalesce((select jsonb_agg(jsonb_build_object('agentRowId',agent_row_id,'accountId',account_id,'startsAt',starts_at,'endsAt',ends_at,'provenance',provenance)) from public.team_account_parent_history where team_id=p_team),'[]')));
end $$;
-- New source assignment must fail even through old RPCs. Existing references remain readable.
create function private.account_active_assignment_guard() returns trigger language plpgsql security definer set search_path='' as $$begin
 if not private.team_account_effectively_active(new.team_id,new.agent_row_id) then raise exception 'ACCOUNT_ARCHIVED' using errcode='22023';end if;return new;end $$;
create trigger account_active_assignment_guard before insert on public.team_agent_runs for each row execute function private.account_active_assignment_guard();
create trigger account_active_assignment_guard before insert on public.team_task_agents for each row execute function private.account_active_assignment_guard();
-- Guard all ledger paths, preserving successful finance request replay before this trigger.
-- Explicit historical correction is transaction-scoped by the authenticated RPC wrappers below.
create function private.account_finance_guard() returns trigger language plpgsql security definer set search_path='' as $$begin
 perform 1 from public.team_account_agents where id=new.agent_row_id and team_id=new.team_id for update;
 if not private.team_account_effectively_active(new.team_id,new.agent_row_id) and coalesce(current_setting('soty.finance_historical_correction',true),'')<>'yes' then raise exception 'HISTORICAL_CORRECTION_REQUIRED' using errcode='22023';end if;return new;end $$;
create trigger account_finance_guard before insert or update on public.team_agent_finance_values for each row execute function private.account_finance_guard();
-- Guard acceptance even when a normal write would be a no-op, and lock the
-- request before deciding whether this is a successful-receipt replay.
create function private.account_finance_accept(p_team uuid,p_request uuid,p_args jsonb,p_intent text) returns void language plpgsql security definer set search_path='' as $$ declare ids uuid[];begin
 perform pg_advisory_xact_lock(hashtextextended(p_team::text||auth.uid()::text||p_request::text,0));
 if exists(select 1 from public.team_agent_finance_requests where team_id=p_team and actor_id=auth.uid() and request_id=p_request) then return;end if;
 if p_args ? 'p_agent' then ids:=array[(p_args->>'p_agent')::uuid];
 elsif p_args ? 'p_fields' then select array_agg((x->>'agent')::uuid) into ids from jsonb_array_elements(p_args->'p_fields') x;
 elsif p_args ? 'p_legacy' then select array_agg(agent_row_id) into ids from public.team_agent_finance_legacy where team_id=p_team and id=(p_args->>'p_legacy')::uuid;
 elsif p_args ? 'p_original_request_id' then select array_agg(distinct agent_row_id) into ids from public.team_agent_finance_events where team_id=p_team and actor_id=auth.uid() and request_id=(p_args->>'p_original_request_id')::uuid;end if;
 perform 1 from public.team_accounts where team_id=p_team and id in(select account_id from public.team_account_agents where id=any(ids) and team_id=p_team) order by id for update;
 perform 1 from public.team_account_agents where team_id=p_team and id=any(ids) order by id for update;
 if p_intent='normal' and exists(select 1 from unnest(ids) id where not private.team_account_effectively_active(p_team,id)) then raise exception 'HISTORICAL_CORRECTION_REQUIRED' using errcode='22023';end if;
end $$;
-- Extend every public finance ledger entry point with an optional intent and retain
-- original bodies privately so all existing version/placement/replay rules survive.
do $$ declare f record;args text;decls text;callargs text;jsonargs text;basename text;begin
 for f in select p.oid,p.proname,pg_get_function_arguments(p.oid) declarations,pg_get_function_identity_arguments(p.oid) identity_args,p.proargnames from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('set_team_agent_finance_value','clear_team_agent_finance','clear_team_agent_finance_values','undo_team_agent_finance','undo_team_agent_finance_clear','import_team_agent_finance','import_team_agent_finance_legacy') loop
 basename:=f.proname;select string_agg(quote_ident(name),','),string_agg(quote_literal(name)||','||quote_ident(name),',') into callargs,jsonargs from unnest(f.proargnames) name;
 execute format('alter function public.%I(%s) set schema private',basename,f.identity_args);
 execute format('revoke all on function private.%I(%s) from public,anon,authenticated',basename,f.identity_args);
 if basename='set_team_agent_finance_value' and cardinality(f.proargnames)=8 then
 execute format('create function public.%I(%s) returns jsonb language sql security definer set search_path='''' as $body$ select private.%I(%s) $body$',basename,f.declarations,basename,callargs);
 execute format('revoke all on function public.%I(%s) from public,anon,authenticated',basename,f.identity_args);continue;end if;
 decls:=f.declarations||', p_intent text DEFAULT ''normal''';
 execute format('create function public.%I(%s) returns jsonb language plpgsql security definer set search_path='''' as $body$ declare result jsonb;prior_intent text:=coalesce(current_setting(''soty.finance_historical_correction'',true),'''');begin perform private.finance_access(p_team,''edit'');if p_intent is null or p_intent not in(''normal'',''historical_correction'') then raise exception ''INVALID_INPUT'' using errcode=''22023'';end if;perform private.account_finance_accept(p_team,p_request_id,jsonb_build_object(%s),p_intent);if p_intent=''historical_correction'' then perform set_config(''soty.finance_historical_correction'',''yes'',true);end if;result:=private.%I(%s);perform set_config(''soty.finance_historical_correction'',prior_intent,true);return result;end $body$',basename,decls,jsonargs,basename,callargs);
 execute format('revoke all on function public.%I(%s,text) from public,anon',basename,f.identity_args);
 if not (basename='set_team_agent_finance_value' and cardinality(f.proargnames)=8) then execute format('grant execute on function public.%I(%s,text) to authenticated',basename,f.identity_args);end if;
 end loop;end $$;
do $$ declare f record;definition text;begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in('clear_team_agent_finance_values','import_team_agent_finance_legacy') loop
 definition:=pg_get_functiondef(f.oid);definition:=replace(definition,'public.set_team_agent_finance_value(','private.set_team_agent_finance_value(');execute definition;
 end loop;end $$;
-- Narrow grants on new RPCs; private implementation helpers never callable by clients.
do $$ declare f record;begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('get_team_account_mutation','reorder_team_accounts','get_team_account_archive_preflight','set_team_account_archived','set_team_account_name_color','get_team_accounts_overview','list_team_accounts','list_team_account_archive','get_team_agent_finance_v2') loop execute format('revoke all on function %s from public,anon',f.signature);execute format('grant execute on function %s to authenticated',f.signature);end loop;
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and (p.proname like 'account_%' or p.proname='team_account_effectively_active') loop execute format('revoke all on function %s from public,anon,authenticated',f.signature);end loop;
end $$;
do $$begin if exists(select 1 from pg_publication where pubname='supabase_realtime') then alter publication supabase_realtime add table public.team_account_workspace_signals;end if;end $$;
-- Every newly accepted/generated/manual launch revision validates its stable source.
-- Already accepted generation replay returns before INSERT and remains recoverable.
create function private.account_launch_revision_guard() returns trigger language plpgsql security definer set search_path='' as $$ declare agent uuid;parent uuid;begin
 agent:=nullif(new.sources->>'agentRowId','')::uuid;
 -- Legacy/imported manual revisions can have no RK source; existing public
 -- acceptance seams validate required source identity. Guard every known RK.
 if agent is null then return new;end if;
 select account_id into parent from public.team_account_agents where id=agent and team_id=new.team_id;
 perform 1 from public.team_accounts where id=parent and team_id=new.team_id for update;
 perform 1 from public.team_account_agents where id=agent and team_id=new.team_id for update;
 if not private.team_account_effectively_active(new.team_id,agent) then raise exception 'ACCOUNT_ARCHIVED' using errcode='22023';end if;return new;end $$;
create trigger account_launch_revision_guard before insert on public.team_launch_revisions for each row execute function private.account_launch_revision_guard();
create function private.account_lifecycle_delete_guard() returns trigger language plpgsql security definer set search_path='' as $$begin
 if not exists(select 1 from public.teams where id=old.team_id) then return old;end if;
 if exists(select 1 from public.team_account_lifecycle_events where team_id=old.team_id and entity_id=old.id) or (tg_table_name='team_accounts' and exists(select 1 from public.team_account_lifecycle_events e join public.team_account_agents r on r.id=e.entity_id where e.team_id=old.team_id and r.account_id=old.id)) then raise exception 'FINANCE_HISTORY_PROTECTED' using errcode='23503';end if;return old;end $$;
create trigger account_lifecycle_delete_guard before delete on public.team_accounts for each row execute function private.account_lifecycle_delete_guard();
create trigger account_lifecycle_delete_guard before delete on public.team_account_agents for each row execute function private.account_lifecycle_delete_guard();
revoke all on function private.account_launch_revision_guard(),private.account_lifecycle_delete_guard() from public,anon,authenticated;
commit;
