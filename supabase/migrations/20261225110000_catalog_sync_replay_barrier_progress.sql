-- Production 2026-11-27 (DimSok): «Останнє сканування не вдалося» twenty minutes after
-- «Перевірити зараз», though nothing had failed. The scan walked all 111 folders within a minute
-- and then waited, as designed, behind the replay barrier for the space's change feed to pass
-- the token the walk began at. The feed was moving — fifty changes a run — but its turn came
-- once every six to eight minutes among the other spaces' feeds, while the space's restored
-- background work was writing to Drive faster than that.
--
-- 1. Storage health: a walked scan waiting behind the barrier is progressing for as long as the
--    feed it waits for confirms progress; it is not «sync_failed».
-- 2. Scheduler: a feed that a walked scan waits for is served first, so a person who asked for a
--    scan does not wait behind every other space's background polling.

do $patch$
declare d text;
begin
 select pg_get_functiondef('public.get_team_storage_health(uuid)'::regprocedure) into d;
 if strpos(d,$find$        and job.last_progress_at > clock_timestamp() - interval '15 minutes'
    ) into live_job;$find$)=0 then raise exception 'STORAGE_HEALTH_BARRIER_PATCH_MISSING';end if;
 d:=replace(d,$find$        and job.last_progress_at > clock_timestamp() - interval '15 minutes'
    ) into live_job;$find$,
  $replace$        and job.last_progress_at > clock_timestamp() - interval '15 minutes'
    ) or exists (
      -- A walked scan waiting behind the replay barrier moves with the feed it waits for.
      select 1
      from private.catalog_sync_jobs as finite
      join private.catalog_sync_jobs as feed
        on feed.connection_id = finite.connection_id
       and feed.job_kind = 'incremental'
       and feed.state in ('pending', 'leased', 'retry')
       and feed.attempts < 10
       and feed.last_progress_at > clock_timestamp() - interval '15 minutes'
      where finite.connection_id = connection.id
        and finite.job_kind <> 'incremental'
        and finite.state = 'pending'
        and finite.replay_after is not null
    ) into live_job;$replace$);
 execute d;

 select pg_get_functiondef('private.claim_catalog_sync_jobs(text,integer,integer)'::regprocedure) into d;
 if strpos(d,$find$      select j.id, j.connection_id, j.next_attempt_at, j.created_at, j.job_kind,
        row_number() over$find$)=0
  or strpos(d,$find$    ) eligible where eligible.rank = 1
    order by case when background_turn then$find$)=0
 then raise exception 'CATALOG_SYNC_BARRIER_PRIORITY_PATCH_MISSING';end if;
 d:=replace(d,$find$      select j.id, j.connection_id, j.next_attempt_at, j.created_at, j.job_kind,
        row_number() over$find$,
  $replace$      select j.id, j.connection_id, j.next_attempt_at, j.created_at, j.job_kind,
        -- A feed a walked scan is waiting for (2026-11-27).
        (j.job_kind = 'incremental' and exists (
          select 1 from private.catalog_sync_jobs waiting
          where waiting.connection_id = j.connection_id and waiting.job_kind <> 'incremental'
            and waiting.state = 'pending' and waiting.replay_after is not null
        )) as barrier,
        row_number() over$replace$);
 d:=replace(d,$find$    ) eligible where eligible.rank = 1
    order by case when background_turn then$find$,
  $replace$    ) eligible where eligible.rank = 1
    order by eligible.barrier desc, case when background_turn then$replace$);
 execute d;
end $patch$;
