-- Every retained write returns the same authoritative workspace metadata as
-- overview. Replacing a row after adding/releasing a run must never drop rank.
begin;
-- Clone the existing body rather than renaming its OID: retained SQL/PLpgSQL
-- dependencies must continue to call the original, now-extended function.
do $$ declare definition text;begin
 definition:=pg_get_functiondef('private.team_agent_json(uuid)'::regprocedure);
 definition:=replace(definition,'FUNCTION private.team_agent_json(','FUNCTION private.team_agent_json_legacy_038(');
 execute definition;
end $$;
revoke all on function private.team_agent_json_legacy_038(uuid) from public,anon,authenticated,service_role;
create or replace function private.team_agent_json(p_agent uuid)
returns jsonb language sql stable set search_path='' as $$
 select private.team_agent_json_legacy_038(a.id)||jsonb_build_object(
   'sort_rank',a.sort_rank,
   'archived_at',a.archived_at,
   'lifecycle_version',a.lifecycle_version::text,
   'name_color',coalesce(pref.name_color,0),
   'name_color_version',coalesce(pref.version,0)::text
 )
 from public.team_account_agents a
 left join public.team_account_preferences pref on pref.team_id=a.team_id and pref.agent_id=a.id and pref.user_id=auth.uid()
 where a.id=p_agent;
$$;
revoke all on function private.team_agent_json(uuid) from public,anon,authenticated,service_role;
commit;
