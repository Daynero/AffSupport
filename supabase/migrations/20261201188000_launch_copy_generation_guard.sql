-- Copy uses saved configuration, but must obey the same authoritative active
-- generation lock as the UI. Replaying an already committed copy stays safe.
create or replace function public.copy_launch(p_team uuid,p_source uuid,p_revision uuid,p_expected_version text,p_key text,p_timezone text) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.team_launches%rowtype;r public.team_launch_revisions%rowtype;l public.team_launches%rowtype;cfg jsonb;tomorrow date;result jsonb;replay jsonb;payload jsonb:=jsonb_build_array(p_source,p_revision,p_expected_version,p_timezone);assignee uuid;
begin
 perform private.launch_access(p_team,'view');perform private.launch_access(p_team,'edit');replay:=private.launch_request(p_team,p_key,'copy',payload);if replay is not null then return replay;end if;
 if p_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into s from public.team_launches where id=p_source and team_id=p_team and archived_at is null for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 perform private.launch_unlocked(p_team,p_source);
 if p_expected_version is null or s.aggregate_version::text<>p_expected_version then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 if p_revision is not null or s.active_revision_id is not null then
  select * into r from public.team_launch_revisions where id=coalesce(p_revision,s.active_revision_id) and launch_id=p_source and team_id=p_team;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;cfg:=r.config;
 else cfg:=s.draft_config;end if;
 tomorrow:=(clock_timestamp() at time zone p_timezone)::date+1;cfg:=cfg||jsonb_build_object('launchDate',tomorrow,'timezone',p_timezone);
 assignee:=case when private.team_task_assignee_is_active(p_team,s.assignee_id) then s.assignee_id else null end;
 insert into public.team_launches(team_id,created_by,assignee_id,assignee_label_snapshot,work_status,draft_config,effective_launch_date,copied_from_launch_id,copied_from_revision_id)
 values(p_team,auth.uid(),assignee,private.team_task_assignee_label(assignee),'todo',cfg,tomorrow,p_source,r.id) returning * into l;
 -- No result/source-expectation copied: the new draft must review its current sources.
 result:=jsonb_build_object('id',l.id,'version',l.aggregate_version::text,'launchDate',tomorrow,'assigneeCleared',assignee is null and (s.assignee_id is not null or s.assignee_label_snapshot is not null));
 perform private.launch_signal(p_team,l.id,l.aggregate_version);perform private.launch_remember(p_team,p_key,'copy',payload,result);return result;
end $$;
