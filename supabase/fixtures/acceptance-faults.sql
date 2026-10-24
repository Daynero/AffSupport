-- LOCAL acceptance fixture only
-- The caller owns the surrounding transaction and verified local target
create table private.acceptance_scoped_faults (
  namespace text not null check (namespace ~ '^acceptance-[a-z0-9][a-z0-9-]{2,63}$'),
  fault_id uuid not null,
  kind text not null check (kind in ('lost_acceptance_response','lost_status_response','drive_429','expired_cursor','worker_crash_after_checkpoint','delayed_delivery','missing_signal')),
  resource_kind text not null default 'team_operation' check (resource_kind in ('team_operation','catalog_sync_request')),
  actor_id uuid not null,
  team_id uuid not null,
  operation_id uuid check (operation_id is not null or kind = 'lost_acceptance_response'),
  flow_id uuid not null,
  ttl_ms integer not null check (ttl_ms between 1000 and 300000),
  delay_ms integer,
  state text not null check (state in ('armed','claimed','effect_started','observed','cleared')),
  created_at_ms bigint not null check (created_at_ms between 0 and 9007199254740991),
  expires_at_ms bigint not null check (expires_at_ms between 0 and 9007199254740991),
  changed_at_ms bigint not null check (changed_at_ms between 0 and 9007199254740991),
  primary key (namespace,fault_id),
  check (expires_at_ms = created_at_ms + ttl_ms),
  check (changed_at_ms >= created_at_ms),
  check ((kind = 'delayed_delivery' and delay_ms is not null and delay_ms between 1 and least(ttl_ms,15000))
    or (kind <> 'delayed_delivery' and delay_ms is null))
);
alter table private.acceptance_scoped_faults enable row level security;
alter table private.acceptance_scoped_faults force row level security;
revoke all on private.acceptance_scoped_faults from public, anon, authenticated, service_role;
comment on table private.acceptance_scoped_faults is 'soty.acceptance.faults.v1';
