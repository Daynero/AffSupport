-- A reopened launch counted its generation from 00:00: the elapsed clock lived
-- only in the browser that started it, so another tab, window or computer
-- showed 00:31 for a generation that had run for seven minutes (1.4.3 QA).
-- The launch read now also carries when the current attempt began:
-- the generation's creation for its first attempt, the first step of a later
-- attempt, and nothing while a retried attempt has no step yet, so the browser
-- keeps its own clock instead of counting from the first attempt.
begin;

alter function public.get_launch(uuid,uuid,uuid) rename to get_launch_before_started_at;
revoke all on function public.get_launch_before_started_at(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.get_launch(p_team uuid,p_launch uuid,p_revision uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;g public.team_launch_generations%rowtype;started timestamptz;
begin
 result:=public.get_launch_before_started_at(p_team,p_launch,p_revision);
 if result#>>'{generation,id}' is null then return result;end if;
 select * into g from public.team_launch_generations where id=(result#>>'{generation,id}')::uuid and team_id=p_team;
 if g.id is null then return result;end if;
 if coalesce(g.attempt_no,1)<=1 then started:=g.created_at;
 else
  select min(s.created_at) into started from public.team_launch_generation_steps s
   where s.generation_id=g.id and s.attempt_no=g.attempt_no;
 end if;
 if started is null then return result;end if;
 return jsonb_set(result,'{generation,startedAt}',
  to_jsonb(to_char(started at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
end;
$$;
revoke all on function public.get_launch(uuid,uuid,uuid) from public,anon;
grant execute on function public.get_launch(uuid,uuid,uuid) to authenticated,service_role;

commit;
