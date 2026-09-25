-- A global four-slot cycle reserves one slot for ready background work while
-- preserving prompt manual scans. The advisory transaction lock below already
-- serializes claims; this row makes the cycle durable across worker requests.
create table private.catalog_sync_scheduler_state (
  singleton boolean primary key default true check (singleton),
  claim_sequence bigint not null default 0
);
insert into private.catalog_sync_scheduler_state(singleton, claim_sequence) values (true, 0);
alter table private.catalog_sync_scheduler_state enable row level security;
revoke all on private.catalog_sync_scheduler_state from public, anon, authenticated, service_role;

create or replace function private.claim_catalog_sync_jobs(
  p_worker text, p_limit integer default 5, p_lease_seconds integer default 60
)
returns setof private.catalog_sync_jobs language plpgsql security definer set search_path = '' as $$
declare
  slots integer;
  slot integer;
  candidate record;
  epoch bigint;
  sequence_number bigint;
  background_turn boolean;
begin
  if nullif(p_worker, '') is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  if not pg_try_advisory_xact_lock(71101400) then return; end if;
  update private.catalog_sync_jobs set state = 'failed', lease_owner = null, lease_expires_at = null,
    last_error_code = 'RETRY_EXHAUSTED', completed_at = clock_timestamp()
  where attempts >= 1000 and (state in ('pending', 'retry')
    or (state = 'leased' and lease_expires_at <= clock_timestamp()));
  select greatest(0, 3 - count(*)::integer) into slots from private.catalog_sync_jobs
    where state = 'leased' and lease_expires_at > clock_timestamp();
  for slot in 1..least(greatest(p_limit, 1), slots) loop
    update private.catalog_sync_scheduler_state
      set claim_sequence = claim_sequence + 1 where singleton
      returning claim_sequence into sequence_number;
    background_turn := sequence_number % 4 = 0;
    select eligible.id, eligible.connection_id into candidate from (
      select j.id, j.connection_id, j.next_attempt_at, j.created_at, j.job_kind,
        row_number() over (partition by j.connection_id order by
          case when background_turn then
            case j.job_kind when 'incremental' then 0 when 'initial' then 1
              when 'discovered_subtree' then 2 else 3 end
          else case j.job_kind when 'user_subtree' then 0
              when 'discovered_subtree' then 1 when 'initial' then 2 else 3 end end,
          j.next_attempt_at, j.created_at, j.id) as rank
      from private.catalog_sync_jobs j
      join public.team_drive_connections c on c.id = j.connection_id
      where c.state <> 'detached' and j.replay_after is null
        and j.next_attempt_at <= clock_timestamp()
        and (j.state in ('pending', 'retry') or
          (j.state = 'leased' and j.lease_expires_at <= clock_timestamp()))
        and not exists (select 1 from private.catalog_sync_jobs busy
          where busy.connection_id = j.connection_id and busy.state = 'leased'
            and busy.lease_expires_at > clock_timestamp())
    ) eligible where eligible.rank = 1
    order by case when background_turn then
        case eligible.job_kind when 'incremental' then 0 when 'initial' then 1
          when 'discovered_subtree' then 2 else 3 end
      else case eligible.job_kind when 'user_subtree' then 0
          when 'discovered_subtree' then 1 when 'initial' then 2 else 3 end end,
      eligible.next_attempt_at, eligible.created_at, eligible.id limit 1;
    if not found then exit; end if;
    update private.catalog_sync_authority set lease_epoch = lease_epoch + 1
      where connection_id = candidate.connection_id returning lease_epoch into epoch;
    return query update private.catalog_sync_jobs j set state = 'leased', lease_owner = p_worker,
      lease_epoch = epoch, run_count = run_count + 1,
      lease_expires_at = clock_timestamp() + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
      next_attempt_at = clock_timestamp() + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
      updated_at = clock_timestamp()
      where j.id = candidate.id returning j.*;
  end loop;
end;
$$;

revoke all on function private.claim_catalog_sync_jobs(text,integer,integer)
  from public, anon, authenticated, service_role;
