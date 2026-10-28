-- A generated source is immutable provenance, not a current operational hold.
-- New holds are accepted only through explicit versioned assignment RPCs.
begin;
create table private.team_launch_assignments (
 launch_id uuid primary key, team_id uuid not null,
 agent_row_id uuid,
 source_agent_row_id uuid,
 state text not null check(state in ('assigned','released','legacy_unknown')),
 version bigint not null default 1 check(version>0),
 updated_at timestamptz not null default clock_timestamp(),
 updated_by uuid references auth.users(id) on delete set null,
 foreign key(launch_id,team_id) references public.team_launches(id,team_id) on delete cascade,
 foreign key(agent_row_id,team_id) references public.team_account_agents(id,team_id),
 check((state='released')=(agent_row_id is null))
);
create index team_launch_assignments_agent on private.team_launch_assignments(team_id,agent_row_id,state);
create table private.team_launch_assignment_events (
 id uuid primary key default gen_random_uuid(),team_id uuid not null,
 launch_id uuid not null,agent_row_id uuid,previous_agent_row_id uuid,
 state text not null check(state in ('assigned','released','legacy_unknown')),
 previous_state text,version bigint not null,actor_id uuid references auth.users(id) on delete set null,
 action text not null check(action in ('legacy_observed','assign','release','archive','release_all')),
 request_key text,occurred_at timestamptz not null default clock_timestamp(),
 foreign key(launch_id,team_id) references public.team_launches(id,team_id) on delete cascade,
 unique(launch_id,version)
);
-- Match the platform's private team-table boundary: FORCE RLS plus no direct
-- client/service grants. Canonical SECURITY DEFINER owners retain their existing
-- privileged execution; no new owner/service policy broadens row access.
alter table private.team_launch_assignments enable row level security;
alter table private.team_launch_assignments force row level security;
alter table private.team_launch_assignment_events enable row level security;
alter table private.team_launch_assignment_events force row level security;
revoke all on private.team_launch_assignments,private.team_launch_assignment_events from public,anon,authenticated,service_role;
-- Both new team tables enter the conservative reference inventory. Preserve its
-- completeness and claimed-file fence; never exclude unknown tables to pass it.
create trigger task_cleanup_reference_fence before insert or update on private.team_launch_assignments
 for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.team_launch_assignment_events
 for each row execute function private.guard_task_cleanup_reference();
-- Existing links cannot prove that work is still current. Never reserve history.
insert into private.team_launch_assignments(launch_id,team_id,agent_row_id,source_agent_row_id,state)
select l.id,l.team_id,a.id,a.id,'legacy_unknown'
from public.team_launches l left join public.team_launch_revisions r on r.id=l.active_revision_id and r.team_id=l.team_id
join public.team_account_agents a on a.team_id=l.team_id and a.id::text=coalesce(r.sources->>'agentRowId',l.draft_config->>'agentRowId')
where l.archived_at is null;
insert into private.team_launch_assignment_events(team_id,launch_id,agent_row_id,state,version,action)
select team_id,launch_id,agent_row_id,state,version,'legacy_observed' from private.team_launch_assignments;

create function private.launch_assignment_json(p_team uuid,p_launch uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('launchId',l.id,'version',coalesce(a.version,0)::text,
 'state',coalesce(a.state,'unassigned'),'agentRowId',a.agent_row_id,
 'sourceAgentRowId',coalesce(case when r.sources->>'agentRowId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (r.sources->>'agentRowId')::uuid end,case when l.draft_config->>'agentRowId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (l.draft_config->>'agentRowId')::uuid end,a.source_agent_row_id))
 from public.team_launches l left join private.team_launch_assignments a on a.launch_id=l.id and a.team_id=l.team_id
 left join public.team_launch_revisions r on r.id=l.active_revision_id and r.team_id=l.team_id
 where l.id=p_launch and l.team_id=p_team;
$$;
create function public.get_launch_assignment(p_team uuid,p_launch uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$ declare r jsonb;begin
 perform private.launch_access(p_team,'view');r:=private.launch_assignment_json(p_team,p_launch);
 if r is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;return r;end $$;
create function public.get_launch_assignment_mutation(p_team uuid,p_key text) returns jsonb
language plpgsql stable security definer set search_path='' as $$begin
 perform private.launch_access(p_team,'view');
 return (select result from public.team_launch_requests where team_id=p_team and actor_id=auth.uid() and request_key=p_key and action in ('assignment','agent-release'));
end $$;
create function private.team_agent_availability(p_team uuid,p_agent uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('status',case when n.assigned>0 or exists(select 1 from public.team_agent_runs where team_id=p_team and agent_row_id=p_agent) then 'busy' when n.legacy>0 then 'unknown' else 'free' end,
 'assignmentCount',n.assigned,'legacyCount',n.legacy)
 from (select count(*) filter(where state='assigned') assigned,count(*) filter(where state='legacy_unknown') legacy from private.team_launch_assignments where team_id=p_team and agent_row_id=p_agent) n;
$$;
create function public.get_team_agent_assignment_state(p_team uuid,p_agent uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$ declare signature text;begin
 perform private.launch_access(p_team,'view');
 if not exists(select 1 from public.team_account_agents where id=p_agent and team_id=p_team) then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select encode(extensions.digest(jsonb_build_array(
 coalesce((select jsonb_agg(jsonb_build_array(launch_id,state,version) order by launch_id) from private.team_launch_assignments where team_id=p_team and agent_row_id=p_agent),'[]'),
 coalesce((select jsonb_agg(jsonb_build_array(id,updated_at) order by id) from public.team_agent_runs where team_id=p_team and agent_row_id=p_agent),'[]'))::text,'sha256'),'hex') into signature;
 return jsonb_build_object('agentRowId',p_agent,'version',signature,'availability',private.team_agent_availability(p_team,p_agent));
end $$;
create function public.set_launch_assignment(p_team uuid,p_launch uuid,p_agent uuid,p_expected_version text,p_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare l public.team_launches%rowtype;a private.team_launch_assignments%rowtype;payload jsonb:=jsonb_build_array(p_launch,p_agent,p_expected_version);result jsonb;replay jsonb;v bigint;old_agent uuid;old_state text;source_agent uuid;
begin
 perform private.launch_access(p_team,'edit');perform private.account_workspace_lock(p_team,auth.uid());
 replay:=private.launch_request(p_team,p_key,'assignment',payload);if replay is not null then return replay;end if;
 select * into l from public.team_launches where id=p_launch and team_id=p_team for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select * into a from private.team_launch_assignments where launch_id=p_launch and team_id=p_team for update;
 if p_expected_version is null or p_expected_version is distinct from coalesce(a.version,0)::text then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 if p_agent is not null then
  if l.archived_at is not null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
  if not exists(select 1 from public.team_account_agents where id=p_agent and team_id=p_team) then raise exception 'NOT_FOUND' using errcode='P0002';end if;
  if not private.team_account_effectively_active(p_team,p_agent) then raise exception 'ACCOUNT_ARCHIVED' using errcode='22023';end if;
 end if;
 old_agent:=a.agent_row_id;old_state:=a.state;source_agent:=(private.launch_assignment_json(p_team,p_launch)->>'sourceAgentRowId')::uuid;
 v:=coalesce(a.version,0)+1;
 insert into private.team_launch_assignments(launch_id,team_id,agent_row_id,source_agent_row_id,state,version,updated_by)
 values(p_launch,p_team,p_agent,source_agent,case when p_agent is null then 'released' else 'assigned' end,v,auth.uid())
 on conflict(launch_id) do update set agent_row_id=excluded.agent_row_id,state=excluded.state,version=excluded.version,updated_at=clock_timestamp(),updated_by=excluded.updated_by;
 insert into private.team_launch_assignment_events(team_id,launch_id,agent_row_id,previous_agent_row_id,state,previous_state,version,actor_id,action,request_key)
 values(p_team,p_launch,p_agent,old_agent,case when p_agent is null then 'released' else 'assigned' end,old_state,v,auth.uid(),case when p_agent is null then 'release' else 'assign' end,p_key);
 update public.team_launches set aggregate_version=aggregate_version+1,updated_at=clock_timestamp() where id=p_launch returning * into l;
 perform private.launch_signal(p_team,p_launch,l.aggregate_version);
 result:=private.launch_assignment_json(p_team,p_launch)||jsonb_build_object('operationId',gen_random_uuid(),'requestKey',p_key);
 perform private.launch_remember(p_team,p_key,'assignment',payload,result);return result;
end $$;
create function public.release_team_agent_assignments(p_team uuid,p_agent uuid,p_expected_version text,p_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare payload jsonb:=jsonb_build_array(p_agent,p_expected_version);result jsonb;replay jsonb;a record;n integer:=0;m integer:=0;begin
 perform private.launch_access(p_team,'edit');perform private.account_workspace_lock(p_team,auth.uid());
 replay:=private.launch_request(p_team,p_key,'agent-release',payload);if replay is not null then return replay;end if;
 if (public.get_team_agent_assignment_state(p_team,p_agent)->>'version') is distinct from p_expected_version then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 if exists(select 1 from private.team_launch_assignments where team_id=p_team and agent_row_id=p_agent and state='legacy_unknown') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 -- Topology lock serializes assignment/manual writers; deterministic launch lock order.
 perform 1 from public.team_launches where team_id=p_team and id in(select launch_id from private.team_launch_assignments where team_id=p_team and agent_row_id=p_agent and state='assigned') order by id for update;
 for a in select * from private.team_launch_assignments where team_id=p_team and agent_row_id=p_agent and state='assigned' order by launch_id for update loop
  update private.team_launch_assignments set state='released',agent_row_id=null,version=version+1,updated_at=clock_timestamp(),updated_by=auth.uid() where launch_id=a.launch_id;
  insert into private.team_launch_assignment_events(team_id,launch_id,previous_agent_row_id,state,previous_state,version,actor_id,action,request_key) values(p_team,a.launch_id,p_agent,'released','assigned',a.version+1,auth.uid(),'release_all',p_key);
  update public.team_launches set aggregate_version=aggregate_version+1,updated_at=clock_timestamp() where id=a.launch_id;
  perform private.launch_signal(p_team,a.launch_id,(select aggregate_version from public.team_launches where id=a.launch_id));n:=n+1;
 end loop;
 delete from public.team_agent_runs where team_id=p_team and agent_row_id=p_agent;get diagnostics m=row_count;
 result:=public.get_team_agent_assignment_state(p_team,p_agent)||jsonb_build_object('operationId',gen_random_uuid(),'requestKey',p_key,'releasedCount',n,'clearedManualCount',m);
 perform private.launch_remember(p_team,p_key,'agent-release',payload,result);return result;
end $$;
create trigger account_workspace_signal after insert or update or delete on private.team_launch_assignments for each row execute function private.account_workspace_signal();

-- Permanent account deletion must explain retained current/unconfirmed work,
-- rather than leaking a raw FK failure. Whole-team cascades retain their cleanup.
create function private.account_assignment_delete_guard() returns trigger language plpgsql security definer set search_path='' as $$begin
 if not exists(select 1 from public.teams where id=old.team_id) then return old;end if;
 if exists(select 1 from private.team_launch_assignments x where x.team_id=old.team_id and x.state in('assigned','legacy_unknown') and
 (x.agent_row_id=old.id or (tg_table_name='team_accounts' and x.agent_row_id in(select a.id from public.team_account_agents a where a.team_id=old.team_id and a.account_id=old.id)))) then
 raise exception 'WRONG_STATE' using errcode='55000';end if;return old;end $$;
create trigger account_assignment_delete_guard before delete on public.team_account_agents for each row execute function private.account_assignment_delete_guard();
create trigger account_assignment_delete_guard before delete on public.team_accounts for each row execute function private.account_assignment_delete_guard();
-- Every retained account read receives the same uncapped current availability.
alter function private.team_agent_json(uuid) rename to team_agent_json_pre_assignment;
create function private.team_agent_json(p_agent uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select private.team_agent_json_pre_assignment(p_agent)||jsonb_build_object('availability',private.team_agent_availability(a.team_id,a.id)) from public.team_account_agents a where a.id=p_agent;
$$;
-- Preserve the canonical historical/birth projection, append current assignments.
alter function public.get_team_accounts_overview(uuid,date,date,text) rename to get_team_accounts_overview_pre_assignment;
alter function public.get_team_accounts_overview_pre_assignment(uuid,date,date,text) set schema private;
create function public.get_team_accounts_overview(p_team uuid,p_from date,p_to date,p_timezone text) returns jsonb
language plpgsql stable security definer set search_path='' as $$ declare result jsonb;rows jsonb;total bigint;begin
 result:=private.get_team_accounts_overview_pre_assignment(p_team,p_from,p_to,p_timezone);
 select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'agentRowId',x.agent_row_id,'accountId',a.account_id,'revisionId',l.active_revision_id,'launchDate',l.effective_launch_date,'workStatus',l.work_status,'hasResult',l.active_revision_id is not null,'creativeAlias',coalesce(r.config->>'creativeAlias',l.draft_config->>'creativeAlias',''),'method',coalesce(r.config->>'method',l.draft_config->>'method','other'),'unmatchedReason',null,'assignmentState',x.state,'assignmentVersion',x.version::text) order by l.created_at,l.id),'[]') into rows
 from (select bounded.* from private.team_launch_assignments bounded join public.team_launches bl on bl.id=bounded.launch_id and bl.team_id=bounded.team_id where bounded.team_id=p_team and bounded.state in('assigned','legacy_unknown') and bl.archived_at is null order by bl.created_at,bl.id limit 5000) x join public.team_launches l on l.id=x.launch_id and l.team_id=x.team_id
 join public.team_account_agents a on a.id=x.agent_row_id and a.team_id=x.team_id
 left join public.team_launch_revisions r on r.id=l.active_revision_id and r.team_id=l.team_id
 where x.team_id=p_team and x.state in('assigned','legacy_unknown') and l.archived_at is null;
 select count(*) into total from private.team_launch_assignments x join public.team_launches l on l.id=x.launch_id and l.team_id=x.team_id where x.team_id=p_team and x.state in('assigned','legacy_unknown') and l.archived_at is null;
 return result||jsonb_build_object('launchAssignments',rows,'assignmentCoverage',case when total>5000 then 'partial' else 'complete' end);
end $$;
-- Task tags share the same availability truth; old source labels remain historical.
alter function private.team_task_agent_tags(uuid) rename to team_task_agent_tags_pre_assignment;
create function private.team_task_agent_tags(p_task uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(j.value||jsonb_build_object('availability',private.team_agent_availability(a.team_id,a.id)) order by j.ordinal),'[]')
 from jsonb_array_elements(private.team_task_agent_tags_pre_assignment(p_task)) with ordinality j(value,ordinal)
 join public.team_account_agents a on a.id=(j.value->>'agent_row_id')::uuid;
$$;
revoke all on function private.team_task_agent_tags(uuid) from public,anon,authenticated,service_role;
-- Fresh generation must be explicitly assigned to its intended RK. The earlier
-- durable-request replay branch remains before this check, preserving recovery.
do $$declare definition text;needle text:='fresh:=public.service_launch_sources(p_team,p_launch,p_actor);';begin
 definition:=pg_get_functiondef('public.service_accept_launch_generation_unfenced(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb)'::regprocedure);
 if position(needle in definition)=0 then raise exception 'Launch acceptance seam changed';end if;
 definition:=replace(definition,needle,needle||' if not private.team_account_effectively_active(p_team,(fresh->>''agentRowId'')::uuid) then raise exception ''ACCOUNT_ARCHIVED'' using errcode=''22023'';end if; if not exists(select 1 from private.team_launch_assignments a where a.team_id=p_team and a.launch_id=p_launch and a.state=''assigned'' and a.agent_row_id::text=p_config->>''agentRowId'' and a.agent_row_id::text=p_sources->>''agentRowId'') then raise exception ''WRONG_STATE'' using errcode=''55000'';end if; ');
 execute definition;
end $$;
-- Launch read projections include current assignment without altering source/result.
alter function public.get_launch(uuid,uuid,uuid) rename to get_launch_pre_assignment;
alter function public.get_launch_pre_assignment(uuid,uuid,uuid) set schema private;
create function public.get_launch(p_team uuid,p_launch uuid,p_revision uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$begin
 return private.get_launch_pre_assignment(p_team,p_launch,p_revision)||jsonb_build_object('assignment',public.get_launch_assignment(p_team,p_launch));end $$;
alter function public.list_launches(uuid,jsonb,integer) rename to list_launches_pre_assignment;
alter function public.list_launches_pre_assignment(uuid,jsonb,integer) set schema private;
create function public.list_launches(p_team uuid,p_filter jsonb default '{}',p_limit integer default 50) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare result jsonb;items jsonb;begin
 result:=private.list_launches_pre_assignment(p_team,p_filter,p_limit);
 select coalesce(jsonb_agg(j.value||jsonb_build_object('assignment',private.launch_assignment_json(p_team,(j.value->>'id')::uuid),'agentFree',case when a.state='assigned' and a.agent_row_id::text=private.launch_assignment_json(p_team,(j.value->>'id')::uuid)->>'sourceAgentRowId' and private.team_agent_availability(p_team,a.agent_row_id)->>'status' in ('free','busy') then (private.team_agent_availability(p_team,a.agent_row_id)->>'status')='free' else null end) order by j.ordinal),'[]') into items
 from jsonb_array_elements(result->'items') with ordinality j(value,ordinal) left join private.team_launch_assignments a on a.launch_id=(j.value->>'id')::uuid and a.team_id=p_team;
 return jsonb_set(result,'{items}',items);end $$;
-- Archiving whole launch closes its current hold; frozen generation/source survives.
alter function public.archive_launch(uuid,uuid,text,text,boolean) rename to archive_launch_pre_assignment;
alter function public.archive_launch_pre_assignment(uuid,uuid,text,text,boolean) set schema private;
create function public.archive_launch(p_team uuid,p_launch uuid,p_expected_version text,p_key text,p_suppress boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$ declare result jsonb;a private.team_launch_assignments%rowtype;begin
 perform private.account_workspace_lock(p_team,auth.uid());
 result:=private.archive_launch_pre_assignment(p_team,p_launch,p_expected_version,p_key,p_suppress);
 select * into a from private.team_launch_assignments where team_id=p_team and launch_id=p_launch for update;
 if a.state in('assigned','legacy_unknown') then
 update private.team_launch_assignments set state='released',agent_row_id=null,version=version+1,updated_at=clock_timestamp(),updated_by=auth.uid() where launch_id=p_launch;
 insert into private.team_launch_assignment_events(team_id,launch_id,previous_agent_row_id,state,previous_state,version,actor_id,action,request_key) values(p_team,p_launch,a.agent_row_id,'released',a.state,a.version+1,auth.uid(),'archive',p_key);
 end if;return result;end $$;

-- Content-free authoritative current state plus history; current projection is not as-of.
create view public.analytics_launch_assignments with (security_barrier=true) as
select a.team_id,a.launch_id,a.agent_row_id,a.state,a.version,a.updated_at,a.updated_by actor_id,
 (select count(*) from public.team_agent_runs r where r.team_id=a.team_id and r.agent_row_id=a.agent_row_id) manual_hold_count,
 (select count(*) from private.team_launch_assignments x where x.team_id=a.team_id and x.agent_row_id=a.agent_row_id and x.state='assigned') current_assignment_count
from private.team_launch_assignments a;
create view public.analytics_launch_assignment_events with (security_barrier=true) as
select id,team_id,launch_id,agent_row_id,previous_agent_row_id,state,previous_state,version,actor_id,action,occurred_at from private.team_launch_assignment_events;
revoke all on public.analytics_launch_assignments,public.analytics_launch_assignment_events from public,anon,authenticated,service_role;
do $$begin if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then grant select on public.analytics_launch_assignments,public.analytics_launch_assignment_events to wishly_analytics_ro;end if;end $$;
-- Explicit complete guard: source scanners and actual ingestion use one vocabulary.
create or replace function public.analytics_properties_are_safe_v2(payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) <= 8192
    -- The allowlist: ANALYTICS_PROPERTY_KEYS ∪ TEAM_ANALYTICS_PROPERTY_KEYS.
    and not exists (
      select 1 from jsonb_object_keys(payload) as property_key
      where property_key <> all (array[
        'flow_id', 'run_id', 'tool_identifier', 'feature_identifier', 'screen_identifier',
        'action_identifier', 'flow_step', 'outcome', 'source_kind', 'input_method', 'format',
        'video_codec', 'audio_codec', 'image_codec', 'pixel_format', 'setting_name',
        'setting_value', 'error_category', 'error_code', 'error_stage', 'error_fingerprint',
        'retryable', 'recovered', 'success', 'video_count', 'file_count', 'total_input_bytes',
        'total_output_bytes', 'saving_percent', 'processing_duration_ms', 'duration_ms',
        'queue_wait_ms', 'attempt_number', 'width', 'height', 'mode', 'crf', 'limit_percent',
        'rate_control', 'output_fps', 'target_resolution', 'image_embedding', 'explicit_start_image', 'explicit_end_image', 'has_audio',
        'language', 'marketing_consent',
        'study_run_id', 'attempt_id', 'workflow_id', 'category', 'cue_category', 'action',
        'storage_kind', 'size_bucket', 'cache_state', 'stage', 'assisted', 'invite_persisted',
        'root_confirmed', 'sync_queued', 'workspace_session', 'discovery_completed',
        'production_completed', 'window_index', 'item_count', 'ready_count', 'tile_state',
        'had_agent', 'reason', 'contribution_category', 'contribution_action',
        'selection_count', 'folder_count', 'unavailable_count', 'attention_reason',
        'link_trigger', 'link_origin', 'browser_family', 'link_reason', 'link_stage',
        'link_transport', 'recovery_mode', 'surface', 'instance_changed', 'token_changed',
        'pairing_method', 'link_stream_open',
        'rejected_count', 'evicted_count', 'expired_count', 'rejected_events',
        'evicted_events', 'report_window_ms',
        'account_operation','account_action','account_stage','account_code','account_result','account_entity','account_day','account_coverage','revision_id','launch_stage','launch_action','launch_field','launch_code','launch_method','launch_state'
      ])
    )
    -- No value may be long, path-like, or smell of a credential.
    and not exists (
      select 1 from jsonb_each_text(payload) as property
      where length(property.value) > 128
         or property.value ~ '[/\\]'
         or property.value ~* '(bearer|oauth|token=|authorization)'
    )
    and case when payload ? 'account_operation' then payload ->> 'account_operation' in ('createAccount','renameAccount','setAccountTwoFactor','deleteAccount','addAccountAgent','updateAccountAgent','deleteAccountAgent','addAgentRun','updateAgentRun','deleteAgentRun','setAgentRunMarker','clearAgentRunMarkers','clearAgentRuns','attachAgentLabel','detachAgentLabel','financeClear','financeUndo','financeLegacyImport','financeTransfer','financeHistory','financeExport') else true end
    and case when payload ? 'account_action' then payload ->> 'account_action' in ('overview','reorder','lifecycle','decoration','finance_edit','topup_copy','retained_action') else true end
    and case when payload ? 'account_stage' then payload ->> 'account_stage' in ('held','captured','drop','draft_resolution','preflight','edited','validated','requested','accepted','applied','terminal','clipboard_requested','clipboard_confirmed') else true end
    and case when payload ? 'account_code' then payload ->> 'account_code' in ('NONE','AUTH_REQUIRED','NOT_A_MEMBER','AGENT_ID_CONFLICT','NAME_CONFLICT','WRONG_STATE','DATE_BEFORE_AGENT','TRANSFER_DATE_INVALID','FINANCE_UNDO_ALREADY_APPLIED','LEGACY_ALREADY_IMPORTED','LEGACY_TARGET_OCCUPIED','INVALID_INPUT','INVALID_RESPONSE','PERMISSION_DENIED','NOT_FOUND','ACCOUNT_ARCHIVED','ACCOUNT_SCOPE_CHANGED','PARENT_ARCHIVED','HISTORICAL_CORRECTION_REQUIRED','REQUEST_REPLAY_MISMATCH','FINANCE_CONFLICT','FINANCE_AMOUNT_INVALID','FINANCE_HISTORY_PROTECTED','FINANCE_CLIENT_UPGRADE_REQUIRED','REQUEST_REUSE_CONFLICT','FINANCE_EXPORT_FAILED','FUTURE_FINANCE_DATE','PLACEMENT_CONFLICT','ACCOUNT_ORDER_CONFLICT','ACCOUNT_LIFECYCLE_CONFLICT','ACCOUNT_CONTENT_CONFLICT','ACCOUNT_PREFERENCE_CONFLICT','ACCOUNT_RESULT_UNCERTAIN','VERSION_CONFLICT','CLIPBOARD_DENIED','SOURCE_CHANGED','UNKNOWN') else true end
    and case when payload ? 'account_result' then payload ->> 'account_result' in ('complete','partial','cancelled','noop','conflict','denied','unknown','hidden_no_period_data','retained_period_data','restored','parent_archived','failed') else true end
    and case when payload ? 'account_entity' then payload ->> 'account_entity' in ('social','rk','workspace') else true end
    and case when payload ? 'account_day' then payload ->> 'account_day' in ('today','previous','historical') else true end
    and case when payload ? 'account_coverage' then payload ->> 'account_coverage' in ('complete','accounts_missing','finance_missing','launches_missing','multiple_missing','accounts_only') else true end
    and case when payload ? 'launch_stage' then payload ->> 'launch_stage' in ('validation','draft_saved','accepted','preparing','restitch_preparing','restitch_processing','restitch_uploading','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing','result_committed','cancel','cleanup') else true end
    and case when payload ? 'launch_action' then payload ->> 'launch_action' in ('generate','retry','cancel','save_draft','refresh_sources','save_overrides','restore_config','save_defaults','copy_launch','archive_launch','copy_field','rename_dictionary','archive_dictionary','restore_dictionary','assign_account','release_account') else true end
    and case when payload ? 'launch_field' then payload ->> 'launch_field' in ('advertising_url','catalog_name','catalog_url','campaign_name','budget','ad_range','sub1','sub2','sub3') else true end
    and case when payload ? 'launch_code' then payload ->> 'launch_code' in ('INVALID_INPUT','INVALID_RESPONSE','SOURCE_CHANGED','PERMISSION_DENIED','NOT_FOUND','SPACE_BLOCKED','LAUNCH_BUSY','LAUNCH_VERSION_CONFLICT','LAUNCH_URL_INVALID','LAUNCH_SUB_INVALID','LAUNCH_BUDGET_INVALID','LAUNCH_RESULT_UNCERTAIN','LEASE_MISMATCH','DRIVE_UNAVAILABLE','DRIVE_FILE_MISSING','AGENT_UPDATE_REQUIRED','AGENT_REQUIRED','NEEDS_REAUTH','RESTITCH_INVALID','RESTITCH_NO_SCREENS','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID','RESTITCH_CLIENT_OUTDATED','PROCESS_FAILED','PROCESS_CANCELED','WRONG_STATE','LAUNCH_INTERNAL_ERROR','SHARE_NOT_ALLOWED','NO_WORK','UNKNOWN') else true end
    and case when payload ? 'launch_method' then payload ->> 'launch_method' in ('catalog','other') else true end
    and case when payload ? 'launch_state' then payload ->> 'launch_state' in ('accepted','running','waiting_dependency','partial','failed','interrupted','succeeded','cancel_requested','canceled_with_cleanup_pending','canceled') else true end
    -- Closed vocabularies: ANALYTICS_PROPERTY_ENUMS ∪ TEAM_ANALYTICS_PROPERTY_ENUMS.
    and case when payload ? 'tool_identifier' then
      payload ->> 'tool_identifier' in (
        'compressor','landing-optimizer','landing-preview','transcription','stitcher','two-factor'
      )
      else true end
    and case when payload ? 'outcome' then
      payload ->> 'outcome' in ('success','failure','cancelled','blocked','skipped','unsupported')
      else true end
    and case when payload ? 'error_stage' then
      payload ->> 'error_stage' in (
        -- compressor
        'input','estimate','encode','output','image_embedding', 'explicit_start_image', 'explicit_end_image',
        -- transcription
        'model','transcribe','translate','save',
        -- landing optimizer
        'upload','optimize','package',
        -- landing preview
        'open','render','refresh',
        -- team
        'transfer','process','download','library',
        -- stitcher
        'picker','drop_resolve','input_probe','settings_read','stitch',
        -- tool_ready
        'initial_read','subscribe',
        -- link (032)
        'probe','token','health','entitlement','snapshot','stream'
      )
      else true end
    and case when payload ? 'mode' then
      payload ->> 'mode' in ('optimal','custom')
      else true end
    and case when payload ? 'rate_control' then
      payload ->> 'rate_control' in ('crf','bitrate')
      else true end
    and case when payload ? 'language' then
      payload ->> 'language' in ('en','uk')
      else true end
    and case when payload ? 'category' then
      payload ->> 'category' in ('video','image','archive','transcript','landing','other')
      else true end
    and case when payload ? 'cue_category' then
      payload ->> 'cue_category' in ('geo','offer','language','category')
      else true end
    and case when payload ? 'action' then
      payload ->> 'action' in ('upload','download','rename','move','trash')
      else true end
    and case when payload ? 'storage_kind' then
      payload ->> 'storage_kind' in ('my_drive','shared_drive')
      else true end
    and case when payload ? 'size_bucket' then
      payload ->> 'size_bucket' in ('tiny','small','medium','large','agent')
      else true end
    and case when payload ? 'cache_state' then
      payload ->> 'cache_state' in ('cold','warm','unknown')
      else true end
    and case when payload ? 'stage' then
      payload ->> 'stage' in ('finding','previewing','downloading','processing','uploading','finalizing')
      else true end
    and case when payload ? 'tile_state' then
      payload ->> 'tile_state' in ('ready','candidate','rendering','needs_agent','agent_outdated','error')
      else true end
    and case when payload ? 'reason' then
      payload ->> 'reason' in ('unsupported','corrupt','protected','too_large','render_error')
      else true end
    and case when payload ? 'contribution_category' then
      payload ->> 'contribution_category' in ('local_processing','human_activity')
      else true end
    and case when payload ? 'contribution_action' then
      payload ->> 'contribution_action' in (
        'transcription','translation','landing_optimization','find_selected','task_created',
        'task_completed','batch_completed'
      )
      else true end
    and case when payload ? 'attention_reason' then
      payload ->> 'attention_reason' in ('needs_reauth','root_missing','permission_lost','quota','sync_failed')
      else true end
    and case when payload ? 'link_trigger' then
      payload ->> 'link_trigger' in (
        'boot','visibility','pageshow','online','manual','stream_lost','request_failed',
        'token_changed','retry'
      )
      else true end
    and case when payload ? 'link_origin' then
      payload ->> 'link_origin' in ('hosted','local_copy')
      else true end
    and case when payload ? 'browser_family' then
      payload ->> 'browser_family' in ('safari','chrome','firefox','edge','other')
      else true end
    and case when payload ? 'link_reason' then
      payload ->> 'link_reason' in (
        'not_running','not_installed','blocked_by_browser','pairing_rejected','agent_too_old',
        'web_too_old','account_check_required','account_check_unavailable','update_in_progress',
        'timeout','unknown'
      )
      else true end
    and case when payload ? 'link_stage' then
      payload ->> 'link_stage' in ('probe','token','health','entitlement','snapshot','stream')
      else true end
    and case when payload ? 'link_transport' then
      payload ->> 'link_transport' in ('stream','request','watchdog')
      else true end
    and case when payload ? 'recovery_mode' then
      payload ->> 'recovery_mode' in ('auto','manual','local_copy')
      else true end
    and case when payload ? 'surface' then
      payload ->> 'surface' in (
        'header_badge','home','account','compressor','transcription','stitcher',
        'landing_optimizer','landing_preview','power','team_shell','team_actions',
        'team_process_dialog','team_library_dialog','team_preview','team_landings'
      )
      else true end
    and case when payload ? 'pairing_method' then
      payload ->> 'pairing_method' in ('fragment','handshake','navigation')
      else true end
    -- Booleans are booleans: ANALYTICS_BOOLEAN_KEYS ∪ TEAM_ANALYTICS_BOOLEAN_KEYS.
    and not exists (
      select 1
      from jsonb_each(payload) as property
      where property.key in (
        'retryable','recovered','success','image_embedding', 'explicit_start_image', 'explicit_end_image','has_audio','marketing_consent',
        'assisted','invite_persisted','root_confirmed','sync_queued','workspace_session',
        'discovery_completed','production_completed','had_agent',
        'instance_changed','token_changed','link_stream_open'
      ) and jsonb_typeof(property.value) <> 'boolean'
    )
    -- Numbers are numbers inside the client's closed range:
    -- ANALYTICS_NUMERIC_RANGES ∪ TEAM_ANALYTICS_NUMERIC_RANGES (the wider bound
    -- where the two sanitizers differ, so `duration_ms` keeps the year).
    and not exists (
      select 1
      from jsonb_each(payload) as property
      join (values
        ('video_count', 0, 10000),
        ('file_count', 0, 1000000),
        ('total_input_bytes', 0, 9007199254740991),
        ('total_output_bytes', 0, 9007199254740991),
        ('saving_percent', -10000, 100),
        ('processing_duration_ms', 0, 31536000000),
        ('duration_ms', 0, 31536000000),
        ('queue_wait_ms', 0, 31536000000),
        ('attempt_number', 1, 10000),
        ('width', 0, 131072),
        ('height', 0, 131072),
        ('crf', 0, 63),
        ('limit_percent', 20, 100),
        ('output_fps', 1, 1000),
        ('target_resolution', 16, 32768),
        ('window_index', 1, 4),
        ('item_count', 0, 100000),
        ('ready_count', 0, 100000),
        ('selection_count', 0, 100000),
        ('folder_count', 0, 100000),
        ('unavailable_count', 0, 100000),
        ('rejected_count', 0, 100000),
        ('evicted_count', 0, 100000),
        ('expired_count', 0, 100000),
        ('report_window_ms', 0, 86400000)
      ) as bound(key, low, high) on bound.key = property.key
      where jsonb_typeof(property.value) <> 'number'
         or (property.value #>> '{}')::numeric not between bound.low and bound.high
    )
    -- Opaque identifiers.
    and not exists (
      select 1
      from jsonb_each_text(payload) as property
      where property.key in ('flow_id','run_id','study_run_id','attempt_id','workflow_id','revision_id')
        and property.value !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
    )
    -- The delivery report's two lists: at most ten event names, comma-joined.
    and not exists (
      select 1
      from jsonb_each_text(payload) as property
      where property.key in ('rejected_events','evicted_events')
        and property.value !~ '^[a-z][a-z0-9_]{1,63}(,[a-z][a-z0-9_]{1,63}){0,9}$'
    );
$$;
revoke all on function private.team_agent_json(uuid) from public,anon,authenticated,service_role;
-- Client mutations/readbacks are the only public seams. Helpers and tables remain private.
do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and (p.proname like '%assignment%' or p.proname='team_agent_availability') loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);end loop;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('get_launch_assignment','set_launch_assignment','get_launch_assignment_mutation','get_team_agent_assignment_state','release_team_agent_assignments','get_team_accounts_overview','get_launch','list_launches','archive_launch') loop execute format('revoke all on function %s from public,anon',f.signature);execute format('grant execute on function %s to authenticated',f.signature);end loop;
end $$;
commit;
