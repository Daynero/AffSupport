-- All account entry points take the same topology locks before their existing
-- request/parent/agent locks. This prevents create-vs-archive and transfer-vs-
-- archive lock inversions; money writes never bump the ordering revision.
begin;
create function private.account_workspace_lock(p_team uuid,p_actor uuid) returns void language plpgsql security definer set search_path='' as $$begin
 if p_actor is null or not private.can(p_team,'view',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 -- Teams created after 038 have no scope row until their first social is added.
 insert into public.team_account_order_scopes(team_id,scope,parent_id) values(p_team,'socials',p_team) on conflict do nothing;
 perform 1 from public.team_account_order_scopes where team_id=p_team order by scope,parent_id for update;
end $$;
revoke all on function private.account_workspace_lock(uuid,uuid) from public,anon,authenticated;
do $$ declare f record;definition text;actor text;begin
 for f in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where n.nspname='public' and l.lanname='plpgsql' and p.proname in(
 'create_team_account','rename_team_account','delete_team_account','add_team_account_agent','add_team_account_agent_with_2fa','update_team_account_agent','delete_team_account_agent','move_team_account_agent',
 'add_team_agent_run','update_team_agent_run','delete_team_agent_run','clear_team_agent_runs','attach_team_task_agent','detach_team_task_agent',
 'set_team_agent_finance_value','clear_team_agent_finance_values','undo_team_agent_finance_clear','import_team_agent_finance_legacy',
 'set_team_account_archived','reorder_team_accounts','set_team_account_name_color','service_accept_launch_generation') loop
 definition:=pg_get_functiondef(f.oid);actor:=case when f.proname='service_accept_launch_generation' then 'p_actor' else 'auth.uid()' end;
 definition:=regexp_replace(definition,'\mBEGIN\M','BEGIN PERFORM private.account_workspace_lock(p_team,'||actor||');','i');execute definition;
 end loop;
end $$;
-- Overview joins launch identity by stable source ID, never a name or suffix.
alter function public.get_team_accounts_overview(uuid,date,date,text) rename to account_overview_base_038;
alter function public.account_overview_base_038(uuid,date,date,text) set schema private;
revoke all on function private.account_overview_base_038(uuid,date,date,text) from public,anon,authenticated;
create function public.get_team_accounts_overview(p_team uuid,p_from date,p_to date,p_timezone text) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare base jsonb;summaries jsonb;total bigint;begin
 base:=private.account_overview_base_038(p_team,p_from,p_to,p_timezone);
 select count(*) into total from public.team_launches l where l.team_id=p_team and l.archived_at is null and (l.effective_launch_date is null or l.effective_launch_date between p_from and p_to);
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'agentRowId',x.agent,'accountId',a.account_id,'revisionId',x.active_revision_id,'launchDate',x.effective_launch_date,'workStatus',x.work_status,'hasResult',x.active_revision_id is not null,'creativeAlias',x.alias,'method',x.method,'unmatchedReason',case when x.agent is null then 'missing_agent' when a.id is null then 'unknown_agent' else null end) order by x.created_at,x.id),'[]') into summaries from(
 select l.*,nullif(coalesce(r.sources->>'agentRowId',l.draft_config->>'agentRowId'),'')::uuid agent,coalesce(r.config->>'creativeAlias',l.draft_config->>'creativeAlias','') alias,coalesce(r.config->>'method',l.draft_config->>'method','other') method
 from public.team_launches l left join public.team_launch_revisions r on r.id=l.active_revision_id and r.team_id=p_team where l.team_id=p_team and l.archived_at is null and (l.effective_launch_date is null or l.effective_launch_date between p_from and p_to) order by l.created_at,l.id limit 5000
 ) x left join public.team_account_agents a on a.id=x.agent and a.team_id=p_team;
 return base||jsonb_build_object('launchSummaries',summaries,'launchCoverage',case when total>5000 then 'partial' else 'complete' end);
end $$;
revoke all on function public.get_team_accounts_overview(uuid,date,date,text) from public,anon;
grant execute on function public.get_team_accounts_overview(uuid,date,date,text) to authenticated;
-- Child eligibility changes invalidate a parent's archive preflight as well.
create function private.account_child_lifecycle_revision() returns trigger language plpgsql security definer set search_path='' as $$begin
 if new.entity_kind='agent' then
 update public.team_account_content_revisions set membership_revision=membership_revision+1 where team_id=new.team_id and entity_kind='social' and entity_id=(select account_id from public.team_account_agents where id=new.entity_id and team_id=new.team_id);
 end if;return null;end $$;
create trigger account_child_lifecycle_revision after insert on public.team_account_lifecycle_events for each row execute function private.account_child_lifecycle_revision();
revoke all on function private.account_child_lifecycle_revision() from public,anon,authenticated;
-- Open-task counts are part of Accounts; done/reopen must invalidate peers.
create trigger account_workspace_signal after insert or update or delete on public.team_tasks for each row execute function private.account_workspace_signal();
create function private.account_rehome_active_source() returns trigger language plpgsql security definer set search_path='' as $$begin
 if new.account_id is distinct from old.account_id and (old.archived_at is not null or exists(select 1 from public.team_accounts where id=old.account_id and team_id=old.team_id and archived_at is not null)) then raise exception 'ACCOUNT_ARCHIVED' using errcode='22023';end if;return new;end $$;
create trigger account_rehome_active_source before update of account_id on public.team_account_agents for each row execute function private.account_rehome_active_source();
revoke all on function private.account_rehome_active_source() from public,anon,authenticated;
commit;
