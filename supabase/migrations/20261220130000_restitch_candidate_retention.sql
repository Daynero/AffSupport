-- Backend audit 2026-11-20: private.restitch_selection_candidates is the fastest-growing table
-- after analytics and nothing ever removes a row from it.
--
-- Every re-stitch operation freezes the whole pool of candidate screens it may draw from:
-- about 73 rows of file metadata per root. Ten days after the feature shipped that is 161 000
-- rows and 65 MB, 149 000 of them written in the last week — for 866 distinct files.
--
-- The snapshot exists so that a running operation draws from a pool that cannot shift under
-- it, and it is read only while the operation runs: read_restitch_selection_source_core and
-- cas_restitch_selection_slot_core answer WRONG_STATE unless the operation is pending or
-- running, and service_read_restitch_control_selection lists candidates only for an active
-- control. 99.9% of the stored rows belong to operations that have already ended.
--
-- So the candidates of an operation that ended more than seven days ago are removed. What the
-- 047 design fences stays exactly as it is:
--
--  * roots and slots are not touched — the screen accounting (slot budgets, transfers and
--    their settlements) and private.guard_restitch_selection_deletion are unaffected;
--  * a candidate a screen-range grant points at is kept, with its grant;
--  * an operation that is still pending or running keeps its whole snapshot, however old.
--
-- Seven days leaves the full candidate list in place while an incident with the operation
-- can still be under investigation. The work is bounded per run and walks roots by age,
-- oldest first; a root whose candidates are already gone costs one index probe. There is no
-- lower age bound on purpose: an operation that ends late, or a job that was switched off for
-- a while, must still be reached.
begin;

-- A statement that needs a lock on a table written many times a second must not wait for it
-- indefinitely: every writer queues behind a waiting DDL. Five seconds, then the whole file
-- fails cleanly and is applied again (as 20261218200000 does).
set local lock_timeout = '5s';

create index if not exists restitch_selection_roots_created_idx
  on private.restitch_selection_roots (created_at);

create or replace function private.prune_settled_restitch_candidates(p_roots integer default 200)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  removed integer;
  -- Read once: a variable can bound the index scan, a volatile call in the query cannot.
  cutoff constant timestamptz := clock_timestamp() - interval '7 days';
begin
  with settled as (
    select root.root_operation_id
    from private.restitch_selection_roots as root
    join public.team_operations as operation on operation.id = root.root_operation_id
    where root.created_at < cutoff
      and operation.state in ('succeeded', 'failed', 'canceled')
      and operation.finished_at < cutoff
      and exists (
        select 1 from private.restitch_selection_candidates as candidate
        where candidate.root_operation_id = root.root_operation_id
          and not exists (
            select 1 from private.restitch_screen_range_grants as issued
            where issued.root_operation_id = candidate.root_operation_id
              and issued.slot = candidate.slot
              and issued.version_id = candidate.version_id
          )
      )
    order by root.created_at, root.root_operation_id
    limit least(greatest(coalesce(p_roots, 200), 1), 1000)
  )
  delete from private.restitch_selection_candidates as candidate
  using settled
  where candidate.root_operation_id = settled.root_operation_id
    and not exists (
      select 1 from private.restitch_screen_range_grants as issued
      where issued.root_operation_id = candidate.root_operation_id
        and issued.slot = candidate.slot
        and issued.version_id = candidate.version_id
    );
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function private.prune_settled_restitch_candidates(integer)
  from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('soty-restitch-candidate-retention', '23 * * * *',
      $cron$select private.prune_settled_restitch_candidates()$cron$);
  end if;
end;
$$;

commit;
