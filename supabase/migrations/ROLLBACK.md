# Rollback notes

## 20261202111000_agent_tenant_index_dedup.sql

If the unreferenced duplicate was removed, restore it with
`alter table public.team_account_agents add constraint team_agents_tenant_key unique (id, team_id)`.
The retained tenant key and all foreign keys remain intact. No data is deleted.

## 20261202110000_operational_history_retention.sql

Unschedule `soty-catalog-event-retention` and `soty-cron-history-retention` first.
Drop `private.cleanup_team_catalog_events(integer)` and
`private.cleanup_cron_history(integer)`, then
`public.team_catalog_events_retention_idx`. The managed cron primary key is
unchanged. Already-expired history deleted by a job
cannot be restored by this rollback; recent history, active jobs, audit and
material records were never removed. Schedules can be disabled without dropping
the functions or indexes.

## 20261130120000_space_tariff_notices.sql

Unschedule `wishly-tariff-notices-queue` and `wishly-tariff-notices`
(`select cron.unschedule(jobid) from cron.job where jobname in (...)`), then drop
`public.service_claim_tariff_notices(integer)`,
`public.service_finish_tariff_notice(uuid, boolean, text, boolean)`,
`private.invoke_tariff_notices()`, `private.tariff_notices_endpoint(text)`,
`private.queue_tariff_notices(timestamptz)`,
`private.tariff_notice_still_due(public.space_tariff_notices)` and
`private.tariff_notice_kind(text, integer)`. The `tariff-notices` edge function
then has nothing to claim and answers `{ claimed: 0 }`. Rows already in
`public.space_tariff_notices` stay (the table belongs to the first migration).

## 20261130110000_space_tariffs_background.sql

First give every paused catalog its schedule back, or the old functions will
delete the rows on the next sync:

```sql
update public.team_catalog_updater_items
   set update_interval = paused_interval, next_run_at = now(), paused_interval = null
 where paused_interval is not null;
update public.team_catalog_updaters set paused_by_tariff_at = null;
select private.sync_catalog_updater(team_id) from public.team_catalog_updaters;
```

Unschedule `wishly-tariff-pauses`, drop `public.resume_team_catalog_updater(uuid)`,
`private.apply_tariff_pauses(uuid)`, `private.clear_tariff_pause_mark(uuid)` and
`private.resume_space_sync(uuid)`, and re-apply the bodies this file replaced
from their latest earlier definitions: `private.sync_catalog_updater`,
`private.forget_unscheduled_catalog_item` and `private.claim_catalog_updater_items`
(`20260928120000_catalog_update_now_restitch.sql`),
`public.set_team_catalog_update_interval` and `public.stop_team_catalog_updater`
(`20260920100000_catalog_updater_cancel.sql`), `public.run_team_catalog_update_now`
and `public.service_open_catalog_updater_rounds`
(`20260916170000_catalog_updater_per_catalog.sql`), `private.claim_catalog_sync_jobs`
(`20261022100000_sync_replay_fencing.sql`), `private.invoke_catalog_sync_worker` and
`private.sweep_catalog_sync_orphans` (`20261008100000_sync_orphan_recovery.sql`),
`public.service_claim_preview_warm` (`20260902130000_retry_missing_provider_thumbnail.sql`),
`public.service_claim_archive_inspections` (`20260829170000_team_archive_inspection.sql`),
`public.service_claim_retired_restitch_copies`
(`20260916120000_catalog_updater_restitch_web.sql`) and
`public.service_claim_orphan_cleanups` (`20260918140000_orphan_cleanup.sql`).
Signatures are unchanged, so `create or replace` is enough. Do this only together
with the first file's rollback: on its own, suspended spaces would start
background work again.

## 20261130100000_space_tariffs.sql

Roll the web build back first (the previous build calls none of the new RPCs;
its `join_team_workspace_waitlist()` call keeps working until the step below).
While the legacy rule is still on and no tariff has been granted, nothing has
changed for anybody, and the file can be reversed by re-applying from
`20260809150000_team_workspace_access_gate.sql` the bodies of
`private.team_workspace_allowed`, `public.can_access_team_workspace` (it was
`language sql stable`), `public.list_my_teams` and `public.accept_invitation`;
`private.team_role` from `20260801094000_team_security_foundation.sql`;
`public.create_team` from `20260809120000_team_workspace_waitlist.sql`;
`public.create_invitation` and `public.resend_invitation` from
`20260801095000_team_invitation_drive_actions.sql`; and
`public.service_direct_add_registered_member` from
`20260802100000_team_direct_member_testing.sql`. Then:

```sql
drop trigger teams_tariff_bound_owner on public.teams;
drop function public.join_team_workspace_waitlist(text, text);
-- re-create the zero-argument join_team_workspace_waitlist() from
-- 20260809120000_team_workspace_waitlist.sql, with its revoke/grant lines
drop function public.get_my_space_access(), public.get_team_tariff(uuid),
  public.ack_space_tariff_toast(uuid), public.request_space_owner_nudge(uuid);
-- every public.admin_*tariff*/admin_*space* function this file creates, then
-- the private helpers it creates (kyiv_today, kyiv_day_end, space_tariff_state,
-- team_seat_*, claim_space_tariffs, ...)
alter table public.team_catalog_updaters drop column paused_by_tariff_at;
alter table public.team_catalog_updater_items drop column paused_interval;
alter table public.team_workspace_waitlist
  drop column plan_interest, drop column channel, drop column last_contact_at,
  drop column handled_at, drop column admin_note;
drop table public.space_tariff_notices, public.tariff_settings_events,
  public.tariff_settings, public.space_tariff_events, public.space_tariffs,
  public.tariff_plans;
notify pgrst, 'reload schema';
```

Once tariffs have been granted, dropping `public.space_tariffs` loses who holds
what until when; export it first (`copy public.space_tariffs to stdout csv
header`). Once the legacy rule has been switched off, re-applying the old gate
reopens every space that has an admin member and closes every space that only a
tariff opened — forward-fix instead (grant the missing tariffs, or switch the
legacy rule back on with `admin_set_tariff_settings`).

## 20261126100000_sync_status_running_between_slices.sql

Display-only. Re-applying the `get_team_folder_sync_status` body from
`20261015100000_sync_requests_and_cancel.sql` restores "queued" for a pending
job between worker slices. No data is written or migrated.

## 20261125110000_team_agent_transfer_rehome.sql

Forward-fix only once an agent has moved under it: its values, events and
legacy amounts were rewritten to the new social account and new placement, and
nothing records the old split. Keep the transfer audit's account ids and names,
the nullable placement links (`on delete set null`) and the guard that ignores
zero-length audit placements — restoring the old guard makes every former
account undeletable again, and restoring `not null` fails on events whose
former account was deleted. A web build that still sends an effective date
keeps working; the date is ignored.

## 20261125100000_support_goal_admin_edit.sql

Roll the web build back first (the previous build only calls
`admin_update_support_goal_amount`, which this migration leaves untouched),
then `drop function public.admin_update_support_goal(uuid, text, text, bigint, bigint);`.
Titles and targets already edited stay as they are in `public.support_goals`.

## 20261124100000_agent_journal.sql

Roll the web build back first (or accept that its journal forwarder fails
silently: it swallows every error and never advances its cursor). Then restore
`private.purge_analytics_events(integer)` verbatim from
`20261120100000_analytics_retention.sql` (including its `revoke` line and
comment) — the signature is unchanged, so `create or replace` is enough and the
`analytics-retention` schedule keeps working; only the
`deleted_journal_records` key disappears from its result. Then drop the RPC
and the table, in this order:

```sql
drop function public.ingest_agent_journal(uuid, uuid, jsonb);
drop table public.agent_journal_records;
notify pgrst, 'reload schema';
```

Dropping the table deletes every forwarded journal record; there is nothing to
restore them from except the users' own local journals (`diagnostics.jsonl`,
bounded to 2 000 records). Keep the table (drop only the function) if the
records still matter for an open investigation. Regenerate
`apps/web/src/lib/database.types.ts` afterwards if it was regenerated with the
RPC.

## 20261117110000_analytics_envelope_v3.sql

Restore `public.ingest_analytics_events(jsonb)` verbatim from
`20260721113000_fix_analytics_ingestion.sql` (including its `revoke`/`grant`
lines), then drop the index `analytics_events_attempt_created_idx`, the
constraints `analytics_agent_platform_v3_check` and
`analytics_attempt_id_v3_check`, and finally the columns `attempt_id`,
`agent_platform` and `agent_instance_id` from `public.analytics_events` — in
that order, because the function's INSERT names the columns. Rows ingested in
between lose their Agent identity and the attempt correlation with the columns;
the older function puts a client-sent `attempt_id` back inside `properties`,
where the guard still accepts it, so no 031 web build is refused by the
rollback. A client that only sends `attempt_id` in the envelope (the 031 web)
has that id silently dropped by the restored function; roll the web back with
it if attempt correlation of team events matters for the period. Regenerate
`apps/web/src/lib/database.types.ts` afterwards.

## 20261117100000_analytics_guard_contract.sql

Restore `public.analytics_properties_are_safe_v2(jsonb)` verbatim from
`20261110100000_link_analytics_keys.sql`. The function is immutable and sits in
the check constraint of `public.analytics_events`, so `create or replace` is
the whole rollback: no table, grant or type changes. Rows already ingested with
the keys this file added stay as they are — a check constraint is not
re-evaluated on existing rows and analytics rows are never updated — but every
further `power_limit_changed`, `team_storage_*`, `team_index_completed`,
`team_previews_ready`, `team_landing_*`, `team_library_*`,
`team_task_completed`, `tool_ready`, `analytics_delivery_report` and every
`error_occurred` carrying one of the new `error_stage` words is refused at
ingestion as "Unsafe event properties", and the 031 client counts and reports
each refusal — which the older guard refuses too, so the losses go dark as
well. `tests/analytics-guard-contract.test.ts` fails for as long as the
rollback stands, by design: the client allowlist and the guard disagree again.
Roll the web build back with it, or accept the dark period.

## 20261120100000_analytics_retention.sql

Roll back the analytics CLI first if a build of it already reads
`analytics_daily_events` / `analytics_daily_tool_outcomes` for periods longer
than 90 days. Then stop the schedule, drop the trigger, the two private
functions and the three tables, in this order:

```sql
select cron.unschedule(job.jobid) from cron.job as job
where job.jobname = 'analytics-retention';
drop trigger analytics_events_anonymise_on_user_null on public.analytics_events;
drop function private.anonymise_analytics_event();
drop function private.purge_analytics_events(integer);
drop function private.materialize_analytics_daily(date);
drop table public.analytics_daily_tool_outcomes;
drop table public.analytics_daily_events;
drop table private.analytics_daily_materialized;
notify pgrst, 'reload schema';
```

Two things this does not undo. Events older than 90 days that the purge has
already deleted are gone; only their daily aggregates remain, so consider
keeping the two public tables (drop only the schedule, trigger and functions)
if that history still matters. Rows anonymised by an account deletion keep
`installation_id` and `session_id` as null; that is the FR-057 guarantee and is
not reversible either. `public.ingest_analytics_events(jsonb)`, the event table
itself and its grants are untouched by this migration. If rolling back while
the 03:15 UTC job is running, wait for that invocation to finish before dropping
the functions.

## 20261110100000_link_analytics_keys.sql

Restore `public.analytics_properties_are_safe_v2(jsonb)` verbatim from
`20260801103000_team_analytics.sql`. The function is immutable and sits in the
check constraint of `public.analytics_events`, so `create or replace` is the
whole rollback: no table, grant or type changes. Rows already ingested with the
link keys (`link_trigger`, `link_origin`, `browser_family`, `link_reason`,
`link_stage`, `link_transport`, `recovery_mode`, `surface`, `instance_changed`,
`token_changed`, `pairing_method`, `link_stream_open`) stay as they are — a
check constraint is not re-evaluated on existing rows and analytics rows are
never updated — but every further `link_*`, `reconnect_clicked` and
`blocked_by_browser_detected` event from a 032 web build is refused at
ingestion as "Unsafe event properties", and the `connection` CLI command reads
only what landed before. Roll back the web build with it, or accept that the
link lifecycle goes dark; the older guard also stops bounding `duration_ms`.

## 20260928140000_catalog_restitch_visible_progress.sql

Stop progress reports from the web before reverting. Restore
`public.list_team_product_catalogs(uuid)` from
`20260920110000_catalog_update_real_progress.sql`, then drop
`public.service_report_restitch_job_progress(uuid,uuid,bytea,integer,text)`,
the `catalog_restitch_job_progress_reset` trigger and its function, and the
`progress` and `progress_stage` columns on `private.catalog_restitch_jobs`.
This removes display progress only; queued jobs and video copies remain.

## 20260928130000_catalog_create_with_restitch.sql

Stop new catalog creation with re-stitching and let in-flight creates finish.
Revert the web and `drive-ops` code, then drop
`public.service_link_restitched_product_catalog_companion(uuid,uuid,uuid,uuid,jsonb)`.
Catalogs already created with a re-stitched video keep their in-use copy and
`current_video_link`; the existing updater can continue to serve them.

## 20260928120000_catalog_update_now_restitch.sql

Let one-off catalog updates finish or cancel them before reverting. Restore
`private.sync_catalog_updater`, `private.queue_restitch_jobs`,
`private.claim_catalog_updater_items`, and
`private.forget_unscheduled_catalog_item` from
`20260916170000_catalog_updater_per_catalog.sql`. Then restore the original
`team_catalog_updaters_due_check` from `20260915140000_catalog_updater.sql`.
The old behavior updates an unscheduled catalog without waiting for a
re-stitched copy; existing in-use video copies remain intact.

## 20260927011000_library_totals_role_guard.sql

This migration changes only the body of
`public.list_library_contribution_totals(uuid,timestamptz,timestamptz)`; its
signature, grants and generated types are unchanged. A safe rollback must keep
the null-safe owner/admin guard while restoring any previous function body.
Restoring the original nullable `NOT IN` expression would disclose another
space's contribution aggregates to a non-member. No stored records change.

## 20260927010000_catalog_resync_role_guard.sql

This migration changes only the body of
`public.request_team_catalog_resync(uuid)`; its signature, grants and generated
types are unchanged. If it must be reverted, restore the previous definition
from `20260921130000_admin_can_resync_drive.sql` only after replacing its
nullable `NOT IN` guard with an equivalent null-safe owner/admin check. Restoring
the vulnerable guard would let non-members request a full Drive resync. No jobs,
connections or catalog rows need deletion.

## 20260924180000_upload_folder_claim.sql

Stop new folder intake and let in-flight requests finish. Restore the prior
`drive-ops` code before dropping its service-only claim function. Keep completed
folder/material rows; do not delete their Drive folders. Then:

```sql
drop function public.service_claim_upload_folder(uuid,uuid,text,uuid,text);
delete from public.team_operations where kind = 'folder_create';
alter table public.team_operations drop constraint team_operations_kind_check;
alter table public.team_operations add constraint team_operations_kind_check check (
  kind in ('upload','download','rename','move','trash','restore',
    'content_edit','new_version','process')
);
```

The operation-row deletion is limited to this new kind and only after the old
code no longer needs replay. It does not remove catalog materials or provider
folders. Rollback forfeits automatic retry coordination for those requests.

## 20260924170000_catalog_sync_retention.sql

Stop only the retention schedule, then remove its private function. This does
not restore rows already aged out; finite status history older than seven days
is intentionally not recoverable. Canonical jobs, confirmed cursors and
material rows are not touched by this migration.

```sql
select cron.unschedule(job.jobid) from cron.job as job
where job.jobname = 'wishly-catalog-sync-retention';
drop function private.cleanup_catalog_sync_retention(integer);
```

There is no public RPC/type change. If rolling back during a running cleanup,
wait for that invocation to finish before dropping the function.

## 20260924160000_catalog_sync_fairness.sql

Stop catalog claims and drain live leases. Restore the
`private.claim_catalog_sync_jobs(text,integer,integer)` definition from
`20260924100000_catalog_sync_ownership.sql`, including its narrow grants, then
remove the scheduling counter:

```sql
drop table private.catalog_sync_scheduler_state;
```

The counter contains no provider cursor, material or job progress; keep all
jobs and confirmed checkpoints. The previous claim order is not fair under
sustained manual demand, so make the rollback explicit in monitoring. Public
RPC signatures are unchanged; regenerate types to confirm no public diff.

## 20260924150000_catalog_coverage_health.sql

Switch the web client back to `public.get_team_storage_health(uuid)` first,
then remove only the additive projection. It stores no catalog data and does
not change the existing connection or scan tables:

```sql
drop function public.get_team_storage_health_v2(uuid);
notify pgrst, 'reload schema';
```

Regenerate the affected public type and keep all material rows and confirmed
sync timestamps. A rollback removes coverage/freshness detail from the chip;
it must not make an unconfirmed empty catalog look complete.

## 20260924140000_catalog_discovered_subtrees.sql

Stop the catalog scheduler and drain workers first. Existing discovered jobs
already in the durable frontier must finish or be restarted from their scope;
never discard their material rows or use a partial listing as complete. Restore
the previous `public.request_team_folder_resync(uuid,text)` definition from
`20260924120000_catalog_sync_scope_join.sql`, then remove the service entry and
shared helper:

```sql
drop function public.service_enqueue_discovered_catalog_subtree(uuid,text,bigint,text,text);
drop function private.join_catalog_subtree(uuid,text,text,text);
notify pgrst, 'reload schema';
```

Restore the matching Edge adapter and regenerate public types before resuming.
Without the service entry, change-feed folder events no longer guarantee a
finite descendant scan; keep coverage visibly partial until a forward fix.

## 20260924130000_catalog_invalidation_scope.sql

Stop new Drive mutations and catalog workers while reverting the event shape.
The scoped rows are disposable invalidations, not catalog state or a replay
cursor; do not delete materials. Drop the trigger/function, restore the
publication's old explicit column list, then remove the added column and grant:

```sql
drop trigger catalog_move_scope on public.team_materials;
drop function private.emit_catalog_move_scope();
alter publication supabase_realtime drop table public.team_catalog_events;
alter publication supabase_realtime add table public.team_catalog_events
  (id, team_id, material_id, event_kind, occurred_at);
revoke select (parent_folder_id) on table public.team_catalog_events from authenticated;
alter table public.team_catalog_events drop column parent_folder_id;
```

Regenerate the event types and restore the prior client. Existing team-wide
invalidation events continue to work during rollback, but old/new parent scope
is unavailable until the forward migration is applied again.

## 20260924120000_catalog_sync_scope_join.sql

Stop manual sync requests and drain catalog workers. Restore the
`public.request_team_folder_resync(uuid,text)` body from
`20260922190000_folder_resync_completion.sql`, then reload PostgREST's schema.
The replacement has no new tables or columns. Already widened jobs retain their
broader `requested_folder_id` and must finish or be retried from that scope;
do not shrink a running frontier or discard its seen-generation records.
Keep the T006/T007 ownership and scan migrations in place for those jobs.

```sql
notify pgrst, 'reload schema';
```

## 20260924110000_catalog_scan_generations.sql

Drain catalog workers and stop the scheduler first. Back up the private frontier,
generations and seen sets if the scans must be resumed. The legacy worker cannot
resume their page checkpoints: restart each affected finite scan from its original
scope/selection roots with a new, freshly captured provider start token. Never
truncate a frontier into a bounded JSON queue or treat partial coverage as complete.
Keep all material rows and their identity/metadata.

Restore the epoch overload of `public.service_complete_catalog_sync_job` from
`20260924100000_catalog_sync_ownership.sql` before removing its dependencies, then:

```sql
drop function public.get_team_folder_sync_status(uuid,uuid);
drop function public.service_finish_catalog_folder(uuid,text,bigint,uuid);
drop function public.service_resolve_catalog_candidate(uuid,text,bigint,uuid,text,bigint,text,jsonb);
drop function public.service_catalog_missing_candidates(uuid,text,bigint,uuid);
drop function public.service_commit_catalog_scan_page(uuid,text,bigint,uuid,text,text,jsonb,boolean);
drop function public.service_catalog_scan_frontier(uuid,text,bigint);
drop function public.service_begin_catalog_folder(uuid,text,bigint,text,boolean);
drop function private.upsert_catalog_snapshot(uuid,text,jsonb,pg_snapshot);
drop table private.catalog_scan_seen;
drop table private.catalog_scan_frontier;
drop table private.catalog_scan_generations;
alter table private.catalog_sync_jobs drop column scan_initialized;
drop trigger catalog_material_mutation on public.team_materials;
drop function private.stamp_catalog_mutation();
alter table public.team_materials drop column catalog_mutation_xid;
notify pgrst, 'reload schema';
```

Regenerate public types and restore the matching Edge adapter before resuming.
The removed tables contain rebuildable scan staging only, not user catalog data.

## 20260924100000_catalog_sync_ownership.sql

Prefer a forward fix. Stop the catalog scheduler and drain every worker before
reverting; old workers must not overlap with the new lease protocol. Back up
`private.catalog_sync_jobs` and `private.catalog_sync_authority` first. No
material rows or user metadata need to be deleted.

1. Save each authority's confirmed cursor and provenance. Never recover an
   ambiguous historical cursor by sorting job tokens or update timestamps.
2. Retire active finite jobs and change canceled jobs to failed before restoring
   the old state constraint. Keep at most one active legacy job per connection;
   seed it only from a confirmed authority cursor, or capture a fresh provider
   start token and restart an initial walk. A fresh token alone is not coverage.
3. Drop the new entry points and triggers, then the authority and added columns:

```sql
drop function public.service_bootstrap_catalog_sync(uuid, text, bigint, text);
drop function public.service_claim_catalog_sync_work(text, integer, integer);
drop function public.service_save_catalog_sync_progress(uuid,text,bigint,text,text,text,jsonb,jsonb);
drop function public.service_release_catalog_sync_job(uuid,text,bigint);
drop function public.service_complete_catalog_sync_job(uuid,text,bigint,text,text);
drop function public.service_retry_catalog_sync_job(uuid,text,bigint,text,timestamptz,boolean);
drop trigger catalog_sync_ensure_authority on private.catalog_sync_jobs;
drop trigger catalog_sync_classify on private.catalog_sync_jobs;
drop function private.ensure_catalog_sync_authority();
drop function private.classify_catalog_sync_job();
```

4. Restore `public.get_team_folder_resync_status`, `private.claim_catalog_sync_jobs` and
   `public.service_complete_catalog_sync_job` from
   `20260922190000_folder_resync_completion.sql`, and
   `public.service_retry_catalog_sync_job` from `20260801101000_team_catalog_search.sql`.
   Restore `public.get_team_storage_health` from
   `20260918180000_indexing_must_be_getting_somewhere.sql` before removing `last_progress_at`.
   Then remove the now-unused lease helper, authority and columns:

```sql
drop function private.lock_catalog_sync_lease(uuid, text, bigint);
drop table private.catalog_sync_authority;
drop index private.catalog_sync_one_canonical;
alter table private.catalog_sync_jobs
  drop column job_kind, drop column lease_epoch, drop column run_count,
  drop column last_progress_at, drop column replay_after;
alter table private.catalog_sync_jobs drop constraint catalog_sync_jobs_state_check;
alter table private.catalog_sync_jobs add constraint catalog_sync_jobs_state_check
  check (state in ('pending', 'leased', 'retry', 'succeeded', 'failed'));
grant execute on function public.service_claim_catalog_sync_jobs(text, integer, integer) to service_role;
grant execute on function public.service_save_catalog_sync_progress(uuid,text,text,text,text,jsonb,jsonb),
  public.service_release_catalog_sync_job(uuid,text),
  public.service_complete_catalog_sync_job(uuid,text,text,text),
  public.service_retry_catalog_sync_job(uuid,text,text,timestamptz,boolean),
  public.service_checkpoint_catalog_sync_job(uuid,text,text,text,text,jsonb,jsonb),
  public.service_checkpoint_initial_sync(uuid,text,jsonb,text),
  public.service_begin_change_replay(uuid,uuid) to service_role;
notify pgrst, 'reload schema';
```

5. Restore the matching legacy Edge worker, regenerate public database types,
   validate claims/completion on an isolated database, then resume the scheduler.

These migrations create the complete Wishly account and analytics foundation. Prefer a database backup and a forward-fix after production data exists.

For an empty development project, roll back in reverse order:

0. From `20260731120000_support_goals.sql`: remove `public.support_goals` from the `supabase_realtime` publication, drop `public.admin_update_support_goal_amount(uuid, bigint)` and `public.admin_active_support_goal()`, then drop `public.support_goals`. This removes only the published aggregate goal progress; no donor records exist.
1. From `20260719130000_analytics_readonly.sql`: drop policy `analytics_readonly_select` on `public.analytics_events`, `revoke` the grants and `drop role wishly_analytics_ro` (reassign/drop owned objects first if any), then `drop view public.analytics_users`. This role/view are read-only and safe to recreate by re-running the migration.
2. Drop the seven `admin_*` functions from `20260718212000_admin_functions.sql`.
3. Drop `public.analytics_events`, then `public.analytics_properties_are_safe(jsonb)`.
4. Drop the `on_auth_user_created` trigger on `auth.users`.
5. Drop `public.admin_users` and `public.profiles`.
6. Drop `public.touch_last_seen()`, `public.is_admin()`, `public.handle_new_user()`, `public.set_marketing_consent_time()` and `public.set_updated_at()`.

Dropping `profiles` permanently removes user preferences and consent history. Dropping `analytics_events` permanently removes product analytics. Do not run a destructive rollback against production without exporting the required records and confirming the retention policy first.

## Team media workspace migrations (development recovery only)

0. `20260920110000_catalog_update_real_progress.sql`: re-apply `list_team_product_catalogs` from `20260916180000`; drop `service_set_catalog_update_progress` and `private.catalog_update_progress`.

1. `20260920100000_catalog_updater_cancel.sql`: re-apply `set_team_catalog_update_interval` and `stop_team_catalog_updater` from `20260916170000_catalog_updater_per_catalog.sql`.

2. `20260918180000_indexing_must_be_getting_somewhere.sql`: re-apply `public.get_team_storage_health` from `20260913000500_preview_chip_counts_only_live_work.sql`.
3. `20260918170000_pool_picture_names.sql`: drop `public.list_team_product_catalog_pool_names`; drop and re-apply `service_draw_product_catalog_images` from `20260917170000` (without the name column).
4. `20260918160000_folder_page_companions.sql`: re-apply `public.list_team_folder_page` from `20260906160000_a_file_can_be_tagged.sql`.
5. `20260918150000_missing_reason.sql`: re-apply `service_tombstone_catalog_files` from `20260801101000` and `private.queue_orphan_cleanups` from `20260918140000`; drop `private.is_gone_for_good` and column `team_materials.missing_reason`.
6. `20260918140000_orphan_cleanup.sql`: drop `service_claim_orphan_cleanups`, `service_complete_orphan_cleanup` and `private.queue_orphan_cleanups`; drop table `private.orphan_cleanups`. Files already moved to Drive's bin stay there — restore them from Drive.
7. `20260918130000_catalog_update_in_history.sql`: delete the actorless rows first (`delete from public.team_audit_events where actor_id is null`), then `alter table public.team_audit_events alter column actor_id set not null`; re-apply `service_complete_catalog_update` from `20260918120000` and drop `private.record_team_system_audit`; delete the `catalog.updated` rows from `team_audit_events` if they are unwanted.
8. `20260918120000_catalog_updater_grow.sql`: drop `set/get_team_catalog_updater_grow`; drop column `team_catalog_updaters.grow_products`; re-apply `service_claim_catalog_updater_items` from `20260918110000` and `service_complete_catalog_update` from `20260916120000` (dropping the six-argument form first).
9. `20260918110000_catalog_updater_refresh_texts.sql`: drop `set/get_team_catalog_updater_refresh_texts`; drop column `team_catalog_updaters.refresh_texts`; re-apply `service_claim_catalog_updater_items` from `20260917170000`.
10. `20260918100000_search_by_word_start.sql`: re-apply `public.search_materials` from `20260916230000`; drop `private.material_search_query(text)`.
11. `20260917180000_history_events_in_order.sql`: `alter table public.team_audit_events alter column occurred_at set default now();`
12. `20260917170000_catalog_pools.sql`: drop functions `service_draw_product_catalog_images`, `service_draw_product_catalog_texts`, `private.draw_product_catalog_items`, `private.product_catalog_pool_images`, `list/set_team_product_catalog_image_sources`, `list/replace/update_team_product_catalog_text(s)`, `set/get_team_catalog_updater_refresh_images`; drop tables `private.product_catalog_draws`, `team_product_catalog_texts`, `team_product_catalog_image_sources`; drop column `team_catalog_updaters.refresh_images`; re-apply `service_claim_catalog_updater_items` from `20260916120000` and `set_team_product_catalog_settings` from `20260915010000`; fill null title/description/image_link, drop `price_min`/`price_max`, restore the original checks and NOT NULLs.
13. `20260917160000_catalog_name_and_file_tasks.sql`: drop `public.next_product_catalog_variant(uuid, uuid)` and `public.list_material_tasks(uuid, uuid)`.
14. `20260917150000_agent_counts_open_tasks.sql`: re-apply `private.team_agent_json` from `20260906220000`.
15. `20260917140000_history_actor_id.sql`: drop `public.list_team_audit_events(uuid, integer, timestamptz)` and re-apply it with its grants from `20260917130000`.
16. `20260917130000_history_records_work.sql`: drop triggers `team_tasks_audit_work`, `team_task_attachments_audit`, `team_task_agents_audit`, `team_agent_runs_audit` and functions `private.audit_team_task_work()`, `private.audit_team_task_links()`, `private.audit_team_agent_runs()`, `private.team_agent_label(uuid)`; re-apply `private.record_team_audit` from `20260823120000` and `public.list_team_audit_events` from `20260906140000`.
17. `20260917120000_attachment_parent_folder.sql`: drop `public.list_task_attachment_folders(uuid, uuid)`; re-apply `public.get_team_task` from `20260906200000`.
18. `20260917110000_drive_status_folder_id.sql`: drop `public.get_drive_connection_status(uuid)` and re-apply it with its grants from `20260916100000`.
19. `20260917100000_rename_space.sql`: drop `public.rename_team(uuid, text)`.
20. `20260916230000_search_shows_note.sql`: re-apply `search_materials` from `20260916210000`.
21. `20260916220000_material_notes.sql`: drop `public.get_team_material_note(uuid, uuid)`, re-apply
    `update_material_metadata`, `private.refresh_team_material_search` and its trigger from
    `20260801101000`, then drop the `team_materials_note_check` constraint and the `note` column.
    Dropping the column deletes every note.

22. `20260916210000_search_by_marker.sql`: re-apply `search_materials` from `20260906170000`
    and `get_team_vocab_and_facets` from `20260916200000`. No data is touched.

23. `20260916200000_filter_languages_in_use.sql`: re-apply `get_team_vocab_and_facets` from
    `20260815113000` (without `usedLanguages`). No data is touched.

24. `20260916190000_batch_chooses_its_work.sql`: drop
    `scan_library_requirements(uuid, text, uuid[], boolean, text[])` and re-create the four-argument
    function with its grants from `20260906100000`. No data is touched.

25. `20260916180000_catalog_registry_folder.sql`: drop `list_team_product_catalogs(uuid)` and
    re-create it from `20260916170000` (without `folder_drive_id`). No data is touched.

26. `20260916170000_catalog_updater_per_catalog.sql`: re-apply `private.queue_restitch_jobs`,
    `private.catalog_updater_state`, `save_team_catalog_updater`, `stop_team_catalog_updater`,
    `service_claim_catalog_updater_items`'s `private.claim_catalog_updater_items` and
    `private.invoke_catalog_updater_worker` from `20260916120000`/`20260915140000`, and
    `service_open_catalog_updater_rounds` and `list_team_product_catalogs` (drop and re-create
    with the old columns) from `20260915140000`; drop the trigger
    `team_catalog_updater_items_forget_unscheduled`, the functions
    `private.forget_unscheduled_catalog_item()`, `private.sync_catalog_updater(uuid)`,
    `private.checked_catalogs(uuid, uuid[])`, `set_team_catalog_update_interval`,
    `run_team_catalog_update_now` and `set_team_catalog_updater_restitch`; delete items whose
    `update_interval` is null, then drop the check, the index and the `update_interval` and
    `next_run_at` columns of `team_catalog_updater_items`.

27. `20260916160000_product_catalog_variations.sql`: first leave each video at most one live
    `product_catalog` companion (trash the extra sheets), then re-apply
    `service_link_product_catalog_companion` from `20260915010000`, drop
    `public.list_material_product_catalogs(uuid, uuid)` and
    `public.service_next_product_catalog_variant(uuid, uuid)`, drop
    `team_materials_one_transcript_idx` and re-create `team_materials_one_companion_idx` on
    `(team_id, companion_of, companion_kind) where companion_of is not null and lifecycle =
'active'`, then drop the `variant` column and its check from `team_product_catalogs`.

28. `20260916150000_task_progress_max_per_space.sql`: re-apply `create_team_task` from
    `20260830160000` (the default read from `profiles`), drop
    `public.get_team_task_progress_max_default(uuid)` and
    `public.set_team_task_progress_max_default(uuid, integer)`, then drop the
    `task_progress_max_default` column and its check from `public.teams`. The per-person column
    on `profiles` was never touched. No task data is lost.

29. `20260830170000_task_progress_manual_only.sql`: restore `update_team_task` with the
    auto-fill branch (`elsif next_status = 'done' and not next_manual then next_value := next_max`).
    Pure function redefinition; no data changes.

30. `20260830160000_task_progress_max_default.sql`: restore `create_team_task` to its prior body
    (no `progress_max` from the profile), drop `public.get_task_progress_max_default()` and
    `public.set_task_progress_max_default(integer)`, then drop the `task_progress_max_default`
    column and its check from `public.profiles`. No task data is lost.

31. `20260830150000_video_text_variants_companion.sql`: `list_video_text_variants` gained a
    companion-transcript fallback. To revert, re-create the function from
    `20260830100000`-era definition (library-results only). No data is touched — it is a pure
    function redefinition.

These are forward-only production migrations. Prefer a backup plus a forward fix after any
team has connected storage. For an empty isolated development database, reverse the
feature group in this exact order:

0. `20260830140000_transcript_delete_pref.sql`: drop
   `public.get_transcript_delete_pref()`, `public.set_transcript_delete_pref(text)`, and the
   column `transcript_delete_pref` from `public.profiles`.
1. `20260830130000_landing_render_refresh.sql`: drop
   `public.request_landing_render_refresh(uuid, uuid)`.
2. `20260830120000_transcript_companion_link.sql`: drop
   `public.service_link_transcript_companion(uuid, uuid, uuid, text, text)` and
   `public.service_find_transcript_by_fingerprint(uuid, text)`.
3. `20260830110000_landing_render_lifecycle.sql`: restore the previous body of
   `public.list_landing_renders(uuid, uuid[], text)` from `20260815113000` (without the
   `material.lifecycle = 'active'` join condition).
4. `20260830100000_media_companions.sql`: drop
   `public.get_material_transcript_companion(uuid, uuid)`, the three companion indexes, and the
   columns `companion_of`, `companion_kind`, `audio_fingerprint` from `public.team_materials`.
5. `20260829170000_team_archive_inspection.sql`: drop
   `public.service_commit_archive_inspection(uuid, text, text, text)`,
   `public.service_claim_archive_inspections(integer)` and the column
   `public.team_materials.landing_inspection_claimed_at`. Archives it promoted keep their
   category; they are landings.
6. `20260829160000_team_rescan_after_reconsent.sql`: drop
   `public.service_request_catalog_rescan(uuid, uuid)`. Scans it queued finish on their own.
7. `20260829150000_team_sync_claim_live_connections.sql`: restore the previous body of
   `private.claim_catalog_sync_jobs(text, integer, integer)` from `20260801094000`. The
   jobs it closed as `failed` / `CONNECTION_DETACHED` belonged to detached connections and
   need no reopening.
8. `20260829140000_team_intent_audit.sql`: restore the previous body of
   `public.service_complete_material_group_intent(uuid)` from `20260814101000`. Audit rows
   already written stay; they are history.
9. `20260829130000_team_root_finalize.sql`: restore the previous body of
   `public.service_finalize_uploaded_material`, which read the destination folder as a
   material row.
10. `20260829120000_team_root_reservation.sql`: restore the previous body of
    `public.service_start_team_operation` (the reservation check that required a destination
    material) and recreate `team_operations_name_reservation_idx` on the plain column.
11. `20260829110000_team_root_destination.sql`: drop
    `public.service_get_root_operation_context` and
    `public.service_find_team_name_conflicts_in_folder`. Both are read-only; dropping them
    restores the earlier behaviour, in which the space root could not be a destination.
12. `20260829100000_team_storage_health_stall.sql`: re-apply the previous body of
    `public.get_team_storage_health` from `20260827109000`. Read-only.
13. `20260827109000_team_storage_health.sql`: drop `public.get_team_storage_health`. Read-only;
    nothing depends on it but the storage chip.
14. `20260827108000_team_search_scope.sql`: drop
    `public.search_materials(uuid, text, jsonb, integer, integer, text, text[])` and restore the
    five-argument definition from `20260815118000` (with its grants and comment).
15. `20260827107000_preview_warm_schedule.sql`: `select cron.unschedule(jobid) from cron.job
where jobname = 'wishly-preview-warm'`; drop `private.invoke_preview_warm_worker`; delete
    the `wishly_preview_warm_url` / `wishly_preview_warm_secret` Vault secrets.
16. `20260827106000_team_thumbnail_session.sql`: drop `public.assert_team_member`; delete
    grants with purpose `thumbnail_session`; restore `private.issue_team_transfer_grant`,
    `private.consume_team_transfer_grant` and the purpose check from `20260801093000`
    (without `thumbnail_session`).
17. `20260827105000_team_catalog_page_markers.sql`: drop
    `public.service_commit_thumbnail`, `public.service_claim_preview_warm`,
    `public.service_mark_folder_indexed`; restore `public.service_enqueue_catalog_reconciliation`
    from `20260801101000` (root-only queue). Prepared thumbnails in the bucket become
    unreachable but are harmless; delete the `team-thumbnail-cache` objects if desired.
18. `20260827104000_team_folder_tree_and_paging.sql`: drop `public.list_team_folder_page`,
    `public.list_team_folder_tree`, `public.team_material_kind`. Nothing else depends on them.
19. `20260827103000_team_material_index_columns.sql`: drop `public.remove_team_drive_selection`;
    drop triggers `team_materials_assign_selection` and `team_materials_provider_thumbnail_state` and
    their `private.` functions; drop the three indexes; drop columns `selection_id`,
    `folder_indexed_at`, `provider_thumbnail_state`, `provider_thumbnail_reason`, `provider_thumbnail_version`,
    `provider_thumbnail_claimed_at` from `public.team_materials`.
20. `20260827102000_team_connection_state_011.sql`: drop `public.service_record_access_expiry`,
    `public.service_touch_catalog_reconciled`, `public.service_mark_root_state`; set any
    `root_missing` connection to `needs_reauth`; restore the state and event-kind checks
    without the 011 values (delete 011 event rows first); drop columns `scope_set`,
    `access_expires_at`, `last_reconciled_at` from `public.team_drive_connections`.
21. `20260827101000_team_drive_selections.sql`: drop `public.service_list_connection_selections`,
    `public.add_team_drive_selection`, `public.list_team_drive_selections`; drop trigger
    `team_drive_connections_sync_root_selection` and `private.team_sync_root_selection`; drop
    `public.team_drive_selections`. Do this after `20260827103000` so the FK is gone.
22. `20260827100000_team_error_codes_011.sql`: delete the six 011 rows from
    `public.team_error_codes` (`SELECTION_UNREACHABLE`, `ROOT_SELECTION_REQUIRED`,
    `ROOT_MISSING`, `TREE_TOO_LARGE`, `THUMBNAIL_SESSION_EXPIRED`,
    `RESTRICTED_SCOPE_NOT_APPROVED`). Nothing references them by foreign key.
23. `20260823120000_team_ux_lifecycle.sql`: revoke and drop
    `public.list_team_trashed_materials(uuid, int, timestamptz)`,
    `public.delete_team_task(uuid, uuid)`, `public.delete_draft_team(uuid)`, and
    `public.leave_team(uuid)`. Then restore `private.record_team_audit`'s target key
    whitelist by re-running the definition from
    `20260801094000_team_security_foundation.sql` — do this _after_ dropping
    `delete_team_task`, and only once no `task.deleted` row remains, because the
    narrower whitelist rejects the `task_id`/`task_title` keys those rows carry.
    Nothing here is data: no team, task, material, or Drive file is removed by
    this rollback. Memberships already ended through `leave_team` stay ended, and
    draft teams already deleted are not recoverable — restore them from a backup
    if that matters.
24. `20260815117000_request_catalog_resync.sql`: revoke and drop
    `public.request_team_catalog_resync(uuid)`. Do not delete or cancel the
    resulting catalog jobs or Drive files during production recovery; allow an
    already queued scan to finish, or forward-fix its state explicitly.
25. `20260814102000_creative_library_security.sql`: first remove only
    `team_upload_batches`, `team_upload_batch_items`, `team_library_requirements`, `team_tasks`,
    and `team_task_attachments` from `supabase_realtime`; then revoke all feature RPC grants
    and drop the feature RLS policies. Do not remove any Drive file or sidecar.
26. `20260814101000_creative_library_actions.sql`: stop local Library workers and let their
    leases expire; then drop caller/service RPCs, the membership cleanup/task normalization
    triggers, feature `updated_at` triggers, and their private trigger/helper functions. Resolve
    every `reconciling` group intent before continuing, because catalog rollback cannot repair a
    provider-side partial move.
27. `20260814100000_creative_library_foundation.sql`: export task, contribution, processing
    result and provenance history if it must be retained. Drop in dependency order:
    `team_library_results`, the requirement current-result FK, private attempts, requirements,
    task attachments, tasks, upload items/batches, share preferences, contribution records,
    private enrichments/group intents/folder bindings; then remove Creative Library indexes,
    constraints and columns from `team_materials`. These steps remove only Postgres authority;
    transcript/translation files in Drive remain intact and must be reconciled explicitly.

28. `20260810113000_team_landing_render_delivery.sql` (feature 004 delivery helpers): revoke and
    drop `public.service_invalidate_landing_renders(uuid,text[])`,
    `public.service_get_landing_render_upload(uuid,uuid,uuid)`, and
    `public.service_get_landing_render_artifact(uuid,uuid,text)` plus
    `public.service_get_landing_render_artifact_by_id(uuid,uuid,uuid)` before rolling back the table.
29. `20260810090000_team_landing_renders.sql` (feature 004 — reverse after delivery helpers): revoke and
    drop `public.list_landing_renders(uuid, uuid[], text)`,
    `public.service_start_landing_render(uuid, uuid, uuid, text, text, text)`,
    `public.service_commit_landing_render(uuid, text, integer, text)`,
    `public.service_fail_landing_render(uuid, text)`, and
    `public.service_mark_landing_renders_stale(uuid, uuid)`; then drop
    `public.team_landing_renders`. The table is intentionally not in `supabase_realtime`, so no
    publication change is needed. If a test connection produced render artifacts, delete the
    hidden `.soty/landing-previews/` subtree through the service path first; this rollback never
    deletes source landing files.
30. `20260802100000_team_direct_member_testing.sql`: revoke and drop
    `public.service_direct_add_registered_member(uuid,uuid,text,text)`. Disable
    `TEAM_DIRECT_ADD_MODE` in Edge and web before rollback. Existing memberships are normal
    team memberships and must not be deleted; matching invitations intentionally remain in
    their recorded terminal state.
31. `20260801103000_team_analytics.sql`: revoke/drop
    `public.analytics_team_workspace`, then drop `private.team_pilot_enrollments`. Restore the
    prior `public.analytics_properties_are_safe_v2(jsonb)` body from
    `20260720130000_analytics_v2.sql`; do not drop it because analytics ingestion depends on
    that function. Export pilot interval evidence first if it must be retained.
32. `20260801102000_team_transfer_operations.sql`: revoke/drop `get_operation`,
    `get_material_provenance`, `cancel_team_operation`, and every `service_*` operation,
    source-binding, folder-resolution, transition/finalize/edit/mutation function introduced
    there. Then drop `private.team_operation_intents`. Reconcile any Drive-succeeded operation
    before removal; this rollback never deletes or rewrites its provider file.
33. `20260801101500_team_preview.sql`: revoke/drop `get_material_preview`,
    `service_get_material_transfer_context`, and
    `service_commit_landing_preview_validation`. Revoke outstanding preview grants through the
    existing service path first; cached agent preview directories are cleaned by agent shutdown,
    not by database rollback.
34. `20260801101000_team_catalog_search.sql`: unschedule only the named
    `wishly-team-catalog-sync` Cron job, revoke/drop all search/vocabulary/metadata and catalog
    worker `service_*` functions plus `private.invoke_catalog_sync_worker`; drop
    `team_materials_refresh_search`, its trigger, the search/facet/missing-value indexes, and
    the three landing/transcript identity constraints. Preserve or export transcript/catalog
    rows before removing search support.
35. `20260801100000_team_membership_actions.sql`: revoke/drop `list_team_members`,
    `update_membership`, `remove_member`, `transfer_ownership`, `list_team_audit_events`,
    `owned_team_count`, and `service_revoke_user_team_grants`. Transfer ownership or archive
    affected test teams first so account recovery never creates an ownerless team.
36. `20260801095000_team_invitation_drive_actions.sql`: drop the caller RPCs
    `create_team`, `list_my_teams`, `lookup_invitable_account`, every invitation action,
    `get_drive_connection_status`, and `list_team_materials`; then drop all public
    `service_*` Drive/OAuth functions and the private helpers
    `team_confirmed_email`, `team_expire_invitations`,
    `team_invitation_identity_matches`, and `upsert_google_drive_credential`. Revoke
    service/client grants before dropping. Detach/revoke any test credential through the
    service path first; this rollback never deletes Google Drive files.
37. `20260801094000_team_security_foundation.sql`: remove `team_operations` and
    `team_catalog_events` from `supabase_realtime`; drop the team RLS policies and triggers;
    revoke/drop every function in `private` created by the migration. Do this before dropping
    their backing tables so no definer or policy is left with a broken dependency.
38. `20260801093000_team_operations_audit.sql`: drop `public.team_catalog_events`,
    `public.team_audit_events`, `private.catalog_sync_jobs`,
    `private.team_transfer_grants`, then `public.team_operations`. This permanently removes
    operation recovery, leases, grants, and audit history.
39. `20260801092000_drive_vault_catalog.sql`: detach test connections first; delete their
    Vault secrets through the service accessor; then drop `public.team_material_links`,
    `public.team_materials`, `public.team_drive_connections`,
    `private.drive_oauth_transactions`, and `private.google_drive_credentials`. Drop the
    `private` schema only if no other migration uses it. No Google Drive file is deleted by
    these database steps.
40. `20260801091000_teams_members_invitations.sql`: drop
    `public.team_invitations`, `public.team_members`, and `public.teams`. Keep the `citext`
    extension if another feature uses it.
41. `20260801090000_team_contract_seed.sql`: drop `public.language_options`,
    `public.geo_options`, `public.team_error_codes`, `public.role_permissions`,
    `public.team_permissions`, `public.team_roles`, and finally
    `public.team_contract_settings`.

Never automate this recovery sequence against production. Export audit/provenance/catalog
records and confirm Vault/Google credential revocation before any destructive rollback.

## 20260830180000_finalize_overwrite_support.sql

Re-apply the previous `service_finalize_uploaded_material` definition (from
20260830150000 or the latest prior migration touching it): the three added
`version_of_material_id` conditions are the only changes — removing them
restores the old behavior (overwrite finalize rejected with SOURCE_CHANGED).

## 20260830190000_group_intent_release_reservation.sql

Re-apply the prior `service_complete_material_group_intent` definition (drop
the added `reservation_released_at` line in the succeeded update). Stale
held reservations released manually during this fix stay released.

## 20260903100000_two_factor_notebook.sql

Destructive and irreversible for stored data: the seeds live in Vault, and
dropping the table alone would leave every secret behind as an orphan nobody can
reach or account for. Delete the secrets **first**, through the pointer, and only
then the table:

```sql
delete from vault.secrets
where id in (select vault_secret_id from private.two_factor_entries);

revoke all on function public.list_two_factor_entries() from authenticated;
revoke all on function public.create_two_factor_entry(text, text) from authenticated;
revoke all on function public.update_two_factor_entry(uuid, text, text) from authenticated;
revoke all on function public.delete_two_factor_entry(uuid) from authenticated;

drop function if exists public.delete_two_factor_entry(uuid);
drop function if exists public.update_two_factor_entry(uuid, text, text);
drop function if exists public.create_two_factor_entry(text, text);
drop function if exists public.list_two_factor_entries();
drop function if exists private.two_factor_secret_is_plausible(text);

drop table if exists private.two_factor_entries;
```

Every stored 2FA seed is gone at that point, with no export and no recovery —
each affected person has to re-enrol two-factor authentication with the service
that issued it. Keep the `private` schema; other migrations use it.

## 20260905100000_team_accounts.sql

Feature 017. Dropping the tables loses every account and every agent's run note
in every space; there is no export. For an isolated development database:

```sql
alter publication supabase_realtime drop table public.team_account_agents;
alter publication supabase_realtime drop table public.team_accounts;

drop function if exists public.delete_team_account_agent(uuid, uuid);
drop function if exists public.update_team_account_agent(uuid, uuid, text, text);
drop function if exists public.add_team_account_agent(uuid, uuid, text, text);
drop function if exists public.delete_team_account(uuid, uuid);
drop function if exists public.rename_team_account(uuid, uuid, text);
drop function if exists public.create_team_account(uuid, text);
drop function if exists public.list_team_accounts(uuid);
drop function if exists private.team_agent_note(text);
drop function if exists private.team_account_name(text);

drop table if exists public.team_account_agents;
drop table if exists public.team_accounts;
```

## 20260905120000_team_task_agents.sql

Feature 017, part 2. Dropping the link table loses every tag on every task; the
accounts and agents themselves stay. For an isolated development database:

```sql
alter publication supabase_realtime drop table public.team_task_agents;
drop function if exists public.detach_team_task_agent(uuid, uuid, uuid);
drop function if exists public.attach_team_task_agent(uuid, uuid, uuid);
drop function if exists public.list_team_tasks(uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid);
-- Re-create list_team_tasks, get_team_task and list_team_accounts from
-- 20260815115000, 20260814101000 and 20260905100000 respectively.
drop function if exists private.team_task_agent_tags(uuid);
drop table if exists public.team_task_agents;
alter table public.team_account_agents drop constraint team_account_agents_id_team_unique;
```

## 20260905140000_team_agent_runs.sql

Feature 017, part 3. Runs became rows; the old `note` column is gone. Reversing
keeps at most one run per agent (the newest). For an isolated development database:

```sql
alter table public.team_account_agents add column note text;
alter table public.team_account_agents add constraint team_account_agents_note_length
  check (note is null or char_length(note) between 1 and 120);
update public.team_account_agents as agent set note = (
  select run.note from public.team_agent_runs as run
  where run.agent_row_id = agent.id order by run.created_at desc limit 1);
alter publication supabase_realtime drop table public.team_agent_runs;
drop function if exists public.clear_team_agent_runs(uuid, uuid);
drop function if exists public.delete_team_agent_run(uuid, uuid);
drop function if exists public.update_team_agent_run(uuid, uuid, text);
drop function if exists public.add_team_agent_run(uuid, uuid, text);
drop function if exists public.update_team_account_agent(uuid, uuid, text);
drop function if exists public.add_team_account_agent(uuid, uuid, text, text);
drop function if exists private.team_agent_json(uuid);
drop function if exists private.team_agent_runs_json(uuid);
-- Re-create add/update_team_account_agent, list_team_accounts and
-- private.team_task_agent_tags from 20260905100000 / 20260905120000.
drop table if exists public.team_agent_runs;
```

## 20260905160000_team_task_date.sql

Feature 017, part 4. Dropping the column loses every date a person moved off
the creation day; nothing else depends on it. For an isolated development
database:

```sql
alter publication supabase_realtime drop table public.team_tasks;
alter publication supabase_realtime add table public.team_tasks (
  id, team_id, title, assignee_id, status, progress_max, progress_value,
  progress_manually_set, created_at, updated_at, completed_at
);
-- Re-create update_team_task from 20260830170000 and list_team_tasks from
-- 20260905120000 (both without task_date), then:
alter table public.team_tasks drop column task_date;
```

## 20260905180000_team_task_date_filter.sql

Feature 017, part 4b. Read-path only: no data is written or dropped. Reverting
puts the board back to filtering and ordering by `created_at`, so a task whose
date was moved answers for the day its row was made again.

```sql
drop function if exists public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid, date, date
);
-- Re-create list_team_tasks from 20260905160000 (created_at range and order),
-- then:
drop function if exists private.team_task_sort_at(date, timestamptz);
```

## 20260906010000_library_processing_reaches_catalog.sql

Read-path only: two functions are redefined and no data is written or dropped.
`scan_library_requirements` and `claim_library_job` demanded
`library_stage = 'library'`, a column only the separate placement flow ever
writes — so in a space that simply connected a drive and started working, the
batch scanned an empty set and reported that everything was already up to date
beside fifty-five untranscribed videos. Both now read a null stage as library
work; `finds` stays excluded. Reverting restores the old reading, and the batch
goes back to seeing nothing until placement has run.

```sql
-- Re-create scan_library_requirements and claim_library_job from
-- 20260814101000_creative_library_actions.sql (the `= 'library'` form).
```

## 20260905200000_team_task_attachment_drive_version.sql

Read-path only: `get_team_task` gains `driveVersion` on each attachment, which
the card's "download re-stitched" needs to ask for the right revision. Nothing
is written or dropped; reverting only removes the field from the payload.

```sql
-- Re-create get_team_task from 20260830170000 (without driveVersion).
```

## 20260906020000_library_scan_counts_remaining_work.sql

`scan_library_requirements` counted every video every time: it offered to
transcribe six files that already carried a transcript and to translate
fifty-five that had nothing to translate yet — a hundred and sixteen "jobs"
where there were forty-nine. Transcription now skips a video whose active
`transcript` companion holds text, translation requires one, and requirements
that are no longer warranted are retired to `stale` instead of being counted
forever. The retirement is a write: reverting does not bring those rows back to
`pending`, though the next scan re-creates any that are genuinely still needed.

```sql
-- Re-create scan_library_requirements from 20260906010000.
```

## 20260906030000_library_scope_is_a_set.sql

Both batch RPCs took `p_source uuid`: the whole space, or exactly one file. So
a selection of four videos could not be processed at all, and a folder could
only be walked by asking the same question once per file. `p_sources uuid[]`
says the same thing for any number, bounded at 500. The old signatures are
dropped rather than kept alongside, so a named-argument call cannot land on two
candidates at once — which is also why reverting has to drop the new ones
first.

```sql
drop function if exists public.scan_library_requirements(uuid, text, uuid[]);
drop function if exists public.claim_library_job(uuid, uuid, text[], text, uuid[]);
-- Re-create both from 20260906020000 / 20260906010000 (the `p_source uuid`
-- form), then re-grant execute to authenticated.
```

## 20260906040000_processing_context_reaches_catalog.sql

The last place the batch still demanded `library_stage = 'library'`. The loop
claimed a job and then could not say what it was about: every claim came back
as NOT_FOUND, and a batch over two chosen videos reported "failed: 2" a second
after it started. The migration also returns the rows that failed for this
reason to `pending`, which is a write — reverting leaves them pending rather
than failed, and the next scan decides whether they are still work.

```sql
-- Re-create get_library_processing_context from
-- 20260814101000_creative_library_actions.sql (the `= 'library'` form).
```

## 20260906050000_retry_speaks_of_a_set.sql

`retry_failed_library_jobs` was the last function in this family still taking
one material, so "retry the failed ones" over a chosen set of four hundred fired
four hundred round trips from one press. It now takes the same `uuid[]` scope as
the scan and the claim, bounded at 500. Read-path shape only — the same rows are
returned to `pending` either way. The old signature is dropped rather than kept
alongside, so reverting has to drop the new one first.

```sql
drop function if exists public.retry_failed_library_jobs(uuid, uuid[]);
-- Re-create retry_failed_library_jobs(uuid, uuid) from
-- 20260814101000_creative_library_actions.sql, then re-grant execute to
-- authenticated.
```

## 20260906060000_scan_stays_inside_its_scope.sql

Three things were still team-wide inside a scoped scan: the two housekeeping
sweeps rewrote requirement rows across the whole space on every dialog open, so
reading the counts for three chosen files wrote to every other member's queue;
`landing_optimization` was keyed by the reader's interface language, so opening
the same space in EN and then UA created two requirements per landing and
doubled the count; and nothing indexed `source_material_id`, so every scoped
count and claim scanned the team's whole pending queue. The migration also
restores the repo's `revoke ... from public, anon` convention, which was lost
when three functions were dropped and recreated in 20260906030000/050000.

The rows already written under a language variant are carried over by
20260906070000, which renames them in place; this migration no longer touches
them.

```sql
drop index if exists public.team_library_requirements_source_idx;
-- Re-create scan_library_requirements from 20260906030000 (team-wide sweeps,
-- p_interface_language as the landing variant).
```

## 20260906070000_landing_variant_keeps_its_history.sql

The variant rename in 20260906060000 retired only the `pending` and `failed`
language-keyed landing rows. A finished optimisation is `ready` and kept its
`variant = 'uk'`, which does not collide with the new `'default'` on the unique
key — so the first scan after that migration would have offered a fresh job for
every landing that had already been optimised, in every space. This renames in
place instead: the most advanced row per source version becomes `'default'`, and
the rest are retired to `stale` under a variant of their own so they stop sitting
on the key the survivor needs.

Reverting is not useful on its own — the language variant a row had before is not
recoverable from the row. Revert 20260906060000's function first (which puts the
reader's language back in the variant), and let the next scan re-create what it
wants; the `'default'` rows stay as history.

```sql
-- No inverse. See above.
```

## 20260906080000_one_rule_for_housekeeping.sql

`.DS_Store` and its kind were hidden from the file list by a name rule in the
browser and by nothing anywhere else, so the folder tree's badge counted them
and the list's total did not — the same folder showed two numbers two hundred
pixels apart. `private.is_housekeeping_name` is the one rule now, read by
`list_team_folder_tree` and by both halves of `list_team_folder_page`. Read-path
only; nothing is written. Reverting brings the disagreement back and makes those
rows visible in the list again.

```sql
-- Re-create list_team_folder_tree and list_team_folder_page from
-- 20260827104000_team_folder_tree_and_paging.sql, then:
drop function if exists private.is_housekeeping_name(text);
```

## 20260906090000_folder_subtree_in_one_read.sql

"Process this folder and everything in it" read the drive one folder at a time
from the browser — up to five hundred sequential round trips, and a ceiling that
had to be explained when it was reached. `list_team_folder_subtree` answers the
same three things (the videos and landings, the folders passed through, whether
the read was cut short) in one query, bounded at depth 64 and at `p_max_folders`.
Read-path only. Reverting means restoring the client-side walk in
`apps/web/src/team/explorer/folderScan.ts`, deleted in the same change.

```sql
drop function if exists public.list_team_folder_subtree(uuid, text, integer);
```

## 20260906100000_counting_is_not_queueing.sql

Opening the batch window scanned, and the scan wrote a requirement row for every
candidate in scope — while the window said processing starts only after
confirmation. True of the processing; but those rows are what other members'
devices claim from, so reading the numbers enqueued the work for the space, and
closing the window left it enqueued. `p_commit` splits the two: the window opens
with `false` and counts candidates, Start runs the committing scan. The old
four-argument signature is dropped, so reverting has to drop the new one first.

```sql
drop function if exists public.scan_library_requirements(uuid, text, uuid[], boolean);
-- Re-create scan_library_requirements from 20260906060000 (no p_commit), then
-- re-grant execute to authenticated.
```

## 20260906110000_stale_work_can_come_back.sql

A requirement retired to `stale` keeps its row, and the row keeps the unique key
— so when the same job became warranted again (a video that had no transcript
gets one, and its translation becomes real work) the insert hit `on conflict do
nothing` and dropped it for good. The window counted the candidate and offered
it; the claim loop found no pending row and called the batch complete a second
after Start. A stale row is now revived; pending, leased, running and ready rows
are left exactly as they are. Reverting restores the silent drop.

```sql
-- Re-create scan_library_requirements from 20260906100000 (`do nothing`), then
-- re-grant execute to authenticated.
```

## 20260906120000_offered_work_can_be_claimed.sql

Two states let the window offer work the claim loop could not take. A `failed`
row was counted in the numbers over Start, revived by nothing, and skipped by
the claim, which takes `pending` only — a scope holding three failures from an
earlier session offered three jobs and finished with none. And a `ready` row
whose result was trashed left the video counted as needing work that could never
be claimed, because the video's own version had not changed and no sweep touched
the row. Start now revives `failed` alongside `stale`, a `ready` requirement
whose result is gone is retired before the inserts, and the retirement sweep
covers `failed` so a revived row is not offered when the work is no longer
warranted. Reverting brings both dead ends back.

```sql
-- Re-create scan_library_requirements from 20260906110000 (revival on 'stale'
-- only, no ready-result sweep, retirement over 'pending' only), then re-grant
-- execute to authenticated.
```

## 20260906130000_a_deep_read_says_it_was_cut.sql

`list_team_folder_subtree` stops at sixty-four levels, but reported `truncated`
from the folder ceiling alone — so a tree deeper than that dropped everything
below it and called the read complete, and the window above handed the scope
over as if it were the whole folder. It now ors in `max(depth) >= 64`, erring the
honest way: a tree exactly sixty-four deep with nothing under it is called cut,
which costs a person one extra sentence and never a missing file. Read-path only.

```sql
-- Re-create list_team_folder_subtree from 20260906090000 (breadth-only
-- truncation), then re-grant execute to authenticated.
```

## 20260906140000_history_says_what_it_happened_to.sql

Every history line read as the action, the person, the outcome and the time, and
never the thing it happened to — so three stopped jobs were three identical rows
and the page was unreadable. `list_team_audit_events` now also returns
`subject_label`: the file's name, an invitation's address, or the file behind a
stopped job's operation, resolved at read time so a renamed file reads under the
name it has. Read-path only; nothing is written. The drop-and-create also
restores the `p_limit`/`p_before` defaults, whose loss made the panel's first
read match no signature at all.

```sql
drop function if exists public.list_team_audit_events(uuid, integer, timestamptz);
-- Re-create list_team_audit_events from 20260828120000 (without subject_label),
-- keeping `p_limit integer default 50, p_before timestamptz default null`, then
-- re-grant execute to authenticated.
```

## 20260906200000_tasks_carry_tags.sql

Tags on tasks (018): two new tables (`team_task_labels`, `team_task_label_links`),
their read/write functions, and a `list_team_tasks` that gained `p_labels` (keep
the tasks carrying any of the given tags), `p_sort` (`date` or `label`) and a
`labels` column; `get_team_task` gained `labels` too. Nothing existing changed
shape: a caller that sends neither new argument gets exactly the page part 4b
returned. Reverting drops the dictionary and every tag hung on a task; no task
is touched.

```sql
drop function if exists public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid, date, date, uuid[], text
);
-- Re-create list_team_tasks and get_team_task from 20260905180000 /
-- 20260905200000 (no labels, no p_sort), then re-grant execute to authenticated.
drop function if exists public.attach_team_task_label(uuid, uuid, uuid);
drop function if exists public.detach_team_task_label(uuid, uuid, uuid);
drop function if exists public.list_team_task_labels(uuid);
drop function if exists public.create_team_task_label(uuid, text, text);
drop function if exists public.update_team_task_label(uuid, uuid, text, text);
drop function if exists public.delete_team_task_label(uuid, uuid);
drop function if exists private.team_task_labels(uuid);
drop function if exists private.team_task_label_key(uuid);
drop function if exists private.team_task_label_name(text);
alter publication supabase_realtime drop table public.team_task_label_links;
alter publication supabase_realtime drop table public.team_task_labels;
drop table if exists public.team_task_label_links;
drop table if exists public.team_task_labels;
```

## 20260906210000_the_board_narrows_to_one_person.sql

`list_team_tasks` gained `p_assignee` (one person's tasks) and `p_unassigned`
(the ones nobody is on); asking for both is `INVALID_INPUT`. Adds
`team_tasks_assignee_idx`. Read-path only — nothing is written, and a caller
that sends neither argument gets exactly the page 018 part 1 returned.

```sql
drop function if exists public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid, date, date, uuid[], text,
  uuid, boolean
);
-- Re-create list_team_tasks from 20260906200000 (no p_assignee/p_unassigned),
-- then re-grant execute to authenticated.
drop index if exists public.team_tasks_assignee_idx;
```

## 20260906220000_agents_carry_money_and_tags.sql

Feature 019. Renames `team_task_labels` to `team_labels` and gives it a `scope`
(`task` / `agent`); adds `team_agent_labels`, the two money columns on
`team_account_agents`, and the generic label RPCs in place of the task-only
ones. Reverting drops the agent tags, both money columns and every figure in
them; the task tags survive under the old table name.

```sql
drop function if exists public.attach_team_agent_label(uuid, uuid, uuid);
drop function if exists public.detach_team_agent_label(uuid, uuid, uuid);
drop function if exists public.set_team_agent_money(uuid, uuid, integer, integer);
drop function if exists public.clear_team_agent_topups(uuid);
drop function if exists public.list_team_labels(uuid, text);
drop function if exists public.create_team_label(uuid, text, text, text);
drop function if exists public.update_team_label(uuid, uuid, text, text);
drop function if exists public.delete_team_label(uuid, uuid);
drop function if exists private.team_agent_labels(uuid);
drop function if exists private.team_label_scope(uuid, text);
alter publication supabase_realtime drop table public.team_agent_labels;
drop table if exists public.team_agent_labels;
alter publication supabase_realtime drop table public.team_account_agents;
alter table public.team_account_agents drop column topup, drop column balance;
alter publication supabase_realtime add table public.team_account_agents (
  id, team_id, account_id, agent_id, created_at, updated_at
);
alter table public.team_labels drop column scope;
alter table public.team_labels rename to team_task_labels;
-- Re-create private.team_agent_json, private.team_task_labels,
-- private.team_task_label_key and the four *_team_task_label functions from
-- 20260906200000, then re-grant execute to authenticated.
```

## 20260906230000_the_balances_can_be_cleared_too.sql

Feature 019, part 2: `clear_team_agent_balances`, the mirror of
`clear_team_agent_topups` for what an agent has left. Adds one function and
nothing else; reverting takes the button's server side away and leaves every
figure where it is.

```sql
drop function if exists public.clear_team_agent_balances(uuid);
```

# Catalog progress lease and faster scheduling (20260907140000)

Deploy the previous `catalog-sync` function first (it uses the unchanged legacy
checkpoint). Restore `private.claim_catalog_sync_jobs` from `20260907100000` and
`private.invoke_catalog_sync_worker` from `20260815102000`; reschedule
`wishly-catalog-sync` to `* * * * *`. The new save/release RPCs can remain unused
until all in-flight workers have finished. No catalog rows need to be deleted.

## 20260915010000_product_catalogs.sql

Feature 022: a video's product catalog sheet. Deploy the previous `drive-ops` first, so nothing
creates or links a catalog while the schema goes away. Sheets already created stay in Drive and
in the catalog as ordinary spreadsheets; unlinking them is what lets the old constraint return.

```sql
drop function if exists public.service_link_product_catalog_companion(uuid, uuid, uuid, uuid, jsonb);
drop function if exists public.service_get_team_product_catalog_settings(uuid);
drop function if exists public.get_material_product_catalog(uuid, uuid);
drop function if exists public.set_team_product_catalog_settings(uuid, jsonb);
drop function if exists public.get_team_product_catalog_settings(uuid);
drop table if exists public.team_product_catalogs;
drop table if exists public.team_product_catalog_settings;
update public.team_materials
   set companion_of = null, companion_kind = null
 where companion_kind = 'product_catalog';
alter table public.team_materials drop constraint if exists team_materials_companion_kind_check;
alter table public.team_materials
  add constraint team_materials_companion_kind_check
  check (
    (companion_of is null and companion_kind is null)
    or (companion_of is not null and companion_kind in ('transcript'))
  );
```

## 20260915140000_catalog_updater.sql

Feature 023, delivery 1: the catalog updater. Unschedule the worker first so no round runs while the
schema goes away. Sheets already updated keep their shifted IDs; nothing in Drive needs undoing.

```sql
select cron.unschedule(job.jobid) from cron.job as job where job.jobname = 'wishly-catalog-updater';
drop function if exists private.invoke_catalog_updater_worker();
drop function if exists private.catalog_updater_endpoint(text);
drop function if exists public.service_retry_catalog_update(uuid, text, text, timestamptz);
drop function if exists public.service_complete_catalog_update(uuid, text, integer);
drop function if exists public.service_claim_catalog_updater_items(text, integer, integer);
drop function if exists private.claim_catalog_updater_items(text, integer, integer);
drop function if exists public.service_open_catalog_updater_rounds();
drop function if exists public.stop_team_catalog_updater(uuid);
drop function if exists public.save_team_catalog_updater(uuid, uuid[], text, boolean);
drop function if exists public.get_team_catalog_updater(uuid);
drop function if exists public.list_team_product_catalogs(uuid);
drop function if exists private.catalog_updater_state(uuid);
drop function if exists private.catalog_updater_interval(text);
drop function if exists private.live_product_catalogs(uuid);
drop table if exists public.team_catalog_updater_items;
drop table if exists public.team_catalog_updaters;
alter table public.team_product_catalogs
  drop constraint if exists team_product_catalogs_update_error_check,
  drop constraint if exists team_product_catalogs_update_count_check,
  drop column if exists last_update_error,
  drop column if exists last_updated_at,
  drop column if exists update_count;
```

## 20260916070000_refresh_material_revision.sql

Processes on a file whose Drive version moved without its bytes go back to failing at finalize.

```sql
drop function if exists public.service_refresh_material_revision(uuid, text, text, text);
```

## 20260916100000_catalog_sync_outage_guards.sql

Re-apply `private.invoke_catalog_sync_worker()` from
`20260907140000_catalog_progress_keeps_its_lease.sql`,
`private.claim_catalog_sync_jobs(text, integer, integer)` from that same migration, and
`public.get_drive_connection_status(uuid)` from
`20260801095000_team_invitation_drive_actions.sql`. This restores the silent invalid-config
return and the mismatched connection ordering, so prefer a forward fix in production.

## 20260916120000_catalog_updater_restitch_web.sql

Feature 023: re-stitched copies prepared by an open Soty tab. Turn re-stitching off in every updater
first (`update public.team_catalog_updaters set restitch = false`) and let the worker delete the
retired copies, or they stay in Drive as ordinary materials; the copy each sheet points at stays.
Then re-apply the delivery-1 definitions of `save_team_catalog_updater`, `stop_team_catalog_updater`,
`private.catalog_updater_state`, `private.invoke_catalog_updater_worker`,
`service_claim_catalog_updater_items(text, integer, integer)` and
`service_complete_catalog_update(uuid, text, integer)` from `20260915140000_catalog_updater.sql` after
the drops below.

```sql
drop function if exists public.service_forget_restitch_copy(uuid, boolean);
drop function if exists public.service_claim_retired_restitch_copies(integer);
drop function if exists public.service_complete_catalog_update(uuid, text, integer, uuid);
drop function if exists public.service_claim_catalog_updater_items(text, integer, integer);
drop function if exists public.service_record_restitch_output(uuid, uuid, text, text);
drop function if exists public.service_complete_restitch_job(uuid, uuid, bytea, text, text);
drop function if exists public.service_heartbeat_restitch_job(uuid, uuid, bytea, integer);
drop function if exists public.service_bind_restitch_job_operation(uuid, bytea, uuid);
drop function if exists public.service_claim_restitch_job(uuid, uuid, bytea, integer);
drop function if exists private.retire_restitch_spares(uuid, uuid[]);
drop function if exists private.queue_restitch_jobs(uuid);
drop table if exists private.catalog_restitch_operations;
drop table if exists private.catalog_restitch_jobs;
drop table if exists public.team_catalog_restitch_copies;
alter table public.team_product_catalogs drop column if exists current_video_link;
```

## 20260916130000_catalog_updater_custom_interval.sql

Move every custom interval back to a preset first
(`update public.team_catalog_updaters set update_interval = '1d' where update_interval not in ('1h', '1d', '1w')`),
then restore the preset-only rule and function body from `20260915140000_catalog_updater.sql`:

```sql
alter table public.team_catalog_updaters drop constraint if exists team_catalog_updaters_interval_check;
alter table public.team_catalog_updaters
  add constraint team_catalog_updaters_interval_check check (update_interval in ('1h', '1d', '1w'));
```

## 20260916140000_task_conflict_answers_at_once.sql

Re-apply `public.update_team_task` from `20260905160000_team_task_date.sql` (the same body with the
stale-copy refusal raised as SQLSTATE 40001).

## 20260928150000_team_agent_two_factor.sql

Remove the encrypted Vault values before dropping their pointers. Team agents and their ordinary
account data remain intact; only the optional 2FA credentials are removed.

```sql
delete from vault.secrets as secret
using private.team_agent_two_factor as credential
where secret.id = credential.vault_secret_id;
drop function if exists public.add_team_account_agent_with_2fa(uuid, uuid, text, text, text);
drop function if exists public.list_team_agent_two_factor_seeds(uuid);
drop trigger if exists team_agent_two_factor_delete_secret on private.team_agent_two_factor;
drop function if exists private.delete_team_agent_two_factor_secret();
drop table if exists private.team_agent_two_factor;
```

## 20260929100000_team_account_two_factor.sql

Rolling back removes social-account 2FA seeds. The former agent association is intentionally not
recreated: the new meaning is one seed per social account, and the old per-agent assignments were
discarded when the migration moved them. Restore from a database backup if those credentials are
needed after rollback.

```sql
delete from vault.secrets as secret
using private.team_account_two_factor as credential
where secret.id = credential.vault_secret_id;
drop function if exists public.set_team_account_two_factor_seed(uuid, uuid, text);
drop function if exists public.list_team_account_two_factor_seeds(uuid);
drop trigger if exists team_account_two_factor_delete_secret on private.team_account_two_factor;
drop function if exists private.delete_team_account_two_factor_secret();
drop table if exists private.team_account_two_factor;
```

## 20260930130000_release_security_hardening.sql

No independent rollback: this migration only tightens permissions and RLS. Keep the
hardening in place while either object exists; the objects themselves are removed
by their originating migrations' rollback steps above.

# Feature 027 — daily agent finance

The 20261003100000–20261003103000 migrations preserve undated money in
`team_agent_finance_legacy` and make old writes fail closed. After any daily
entries exist, never drop the finance tables, restore old write RPCs, or copy
daily values back to undated balance/topup. A UI rollback leaves finance editing
unavailable until a forward fix. Export/read access and original legacy values
remain preserved. Validate rollback against a disposable local snapshot first.

# Finance delete compatibility (20261003106000)

Forward-only clarification: transferred agents without financial journal or legacy data remain deletable. A former social account remains protected when its placement explains an agent with financial history. Do not restore the older guard functions: that would reintroduce the deferred-FK failure for transfer-only agents. All monetary archive protections remain enabled. No applied finance migration should be edited.

### Agent finance calendar ranges (20261003107000)

Forward-only widening of snapshot periods to 366 inclusive days. Existing money,
placements, journals and authorization are unchanged. To temporarily hide ranges,
roll back only the source UI; do not remove historical records or edit applied
migrations. A narrower server policy requires a new forward migration.

### Catalog link variation (20261004100000)

Drop `get_team_catalog_updater_random_link_variation(uuid)` and
`set_team_catalog_updater_random_link_variation(uuid, boolean)`. Drop
`service_claim_catalog_updater_items(text, integer, integer)` and restore its
definition and grants from `20260918120000_catalog_updater_grow.sql`. Then drop
`team_catalog_updaters.random_link_variation`. Catalog snapshots can retain the
`randomLinkVariation` key; older workers ignore it.

### Manual full Drive resync (20261006120000)

Forward fix preferred. To roll back only this migration, restore
`public.request_team_catalog_resync(uuid)` from
`20260927010000_catalog_resync_role_guard.sql` and
`public.get_team_folder_resync_status(uuid, uuid)` from
`20260924100000_catalog_sync_ownership.sql`. No data or jobs are removed by
this migration; already queued full scans remain valid.

## 20261008100000_sync_orphan_recovery.sql

Forward fix preferred: the data repair at the end of this file is idempotent
and nothing it does needs undoing. To revert the behaviour only, restore
`private.claim_catalog_sync_jobs(text,integer,integer)` from
`20260924160000_catalog_sync_fairness.sql`,
`public.service_retry_catalog_sync_job(uuid,text,text,timestamptz,boolean)` and
`public.service_complete_catalog_sync_job(uuid,text,text,text)` from
`20260924100000_catalog_sync_ownership.sql`,
`public.request_team_folder_resync(uuid,text)` from
`20260924140000_catalog_discovered_subtrees.sql`,
`public.request_team_catalog_resync(uuid)` and
`public.get_team_folder_sync_status(uuid,uuid)` from
`20261006120000_manual_root_resync_status.sql` and
`20260924110000_catalog_scan_generations.sql`, and
`private.invoke_catalog_sync_worker()` from
`20260916100000_catalog_sync_outage_guards.sql`. Reschedule
`wishly-catalog-sync-retention` to `select private.cleanup_catalog_sync_retention()`
and drop `private.run_catalog_sync_maintenance()`, `private.sweep_catalog_sync_orphans(integer,interval)`,
`private.recover_catalog_sync_feed(uuid,interval)`, `private.nudge_catalog_sync_feed(uuid)`
and `public.find_team_folder_sync_request(uuid,text)`. Keep the new columns
(`error_detail`, `scan_completed_at`, `lease_lost_count`, `recovery_count`,
`last_recovery_at`): they carry defaults and older functions ignore them.
Jobs the sweep retired as `REPLAY_TIMEOUT`, `CANONICAL_FAILED` or
`CONNECTION_DETACHED` stay terminal; a new manual request creates a fresh scan.
Cursor provenance is never touched by this migration or its rollback.

## 20261008110000_sync_diagnostics_view.sql

`drop view public.analytics_catalog_sync_jobs;` — the grant to
`wishly_analytics_ro` goes with it. No data is written or removed by this
migration; the `analytics -- sync` command simply stops working until the
view is restored.

## 20261015100000_sync_requests_and_cancel.sql

Stop the web from calling the keyed request RPCs first (the older two-argument
forms keep working). Then drop `public.cancel_team_folder_sync(uuid,uuid)`,
`public.find_team_folder_sync_request_by_key(uuid,text)`,
`public.request_team_folder_resync(uuid,text,text)`,
`public.request_team_catalog_resync(uuid,text)`,
`private.record_catalog_sync_request(...)`, and the fenced overloads
`public.service_upsert_catalog_page(uuid,text,bigint,uuid,text,jsonb)` and
`public.service_tombstone_catalog_files(uuid,text,bigint,uuid,jsonb)` (the
worker must be rolled back to call the unfenced forms). Restore
`public.request_team_folder_resync(uuid,text)`, `public.request_team_catalog_resync(uuid)`,
`private.claim_catalog_sync_jobs`, `public.get_team_folder_sync_status(uuid,uuid)` from
`20261008100000_sync_orphan_recovery.sql`; `private.lock_catalog_sync_lease` from
`20260924100000_catalog_sync_ownership.sql`; `private.join_catalog_subtree` from
`20260924140000_catalog_discovered_subtrees.sql`; `service_commit_catalog_scan_page`,
`service_resolve_catalog_candidate`, `service_finish_catalog_folder` from
`20260924110000_catalog_scan_generations.sql`; the diagnostics view from
`20261008110000_sync_diagnostics_view.sql`. Keep `private.catalog_sync_requests` and the
new job columns: they hold history and defaults, and nothing older reads them.
No catalog rows or cursors change in either direction.

## 20261022100000_sync_replay_fencing.sql

Roll the `catalog-sync` function back first: the worker built for this
migration calls the fenced overloads. Then drop
`public.service_catalog_sync_lease_live(uuid,text,bigint)` and the fenced
overloads of `service_invalidate_landing_renders`, `service_mark_folder_indexed`,
`service_mark_root_state`, `service_touch_catalog_reconciled` and
`service_enqueue_catalog_reconciliation` (the ones whose first three arguments
are `uuid, text, bigint`); the unfenced originals are untouched. Restore
`public.service_begin_catalog_folder` from `20260924110000_catalog_scan_generations.sql`,
`public.service_finish_catalog_folder`, `private.claim_catalog_sync_jobs` and the
diagnostics view from `20261015100000_sync_requests_and_cancel.sql`. Keep
`catalog_sync_jobs.no_progress_runs`. Jobs retired as `NO_PROGRESS` stay failed;
a new request starts a fresh scan.

## 20261029100000_restitch_sources.sql

Roll the web back first (the panel of this release writes `set_restitch_sources`),
then `drive-ops` (its claim calls `service_draw_restitch_screens` and
`service_defer_restitch_job`). Then drop, in this order:
`public.service_defer_restitch_job(uuid,bytea,text,interval)`,
`public.service_draw_restitch_screens(uuid,uuid,uuid[])`,
`public.draw_restitch_screens(uuid,uuid[])`, `private.draw_restitch_screens_for(uuid,uuid,jsonb,uuid[])`,
`public.set_member_restitch_sources(uuid,text,jsonb)`, `public.set_restitch_sources(uuid,text,jsonb)`,
`private.replace_restitch_sources(uuid,uuid,text,jsonb)`, `public.list_restitch_sources(uuid,text)`,
`private.restitch_listing_json(uuid,uuid)`, `private.restitch_pool_json(uuid,uuid,text)`,
`private.restitch_pool_images(uuid,uuid,text)`, `private.resolve_restitch_pending(uuid)`,
`private.restitch_image_ok(text,bigint,text,text)`, and the table `public.team_restitch_sources`.
Restore `public.set_restitch_defaults(uuid,jsonb)`, `public.set_member_restitch_defaults(uuid,jsonb)`
from `20260929150000_member_restitch_preferences.sql` and
`private.effective_restitch_defaults_json(uuid,uuid)` from
`20261001011000_restitch_defaults_owner_lookup.sql`. Drop the `source_mode` columns from
`team_restitch_defaults` and `team_member_restitch_preferences` last: a row saved in `drive`
mode has empty id lists, so after the rollback that space shows as "not configured" and the
owner re-publishes from a local library. The error codes may stay in `team_error_codes`.

The INSERT policy on the bucket was dropped on purpose. To reopen the bucket for writes
(only together with the rolled-back web), re-create it verbatim from
`20261001010000_restitch_storage_policy_access.sql`:

```sql
create policy team_restitch_images_write on storage.objects for insert to authenticated
with check (
  bucket_id = 'team-restitch-images'
  and (storage.foldername(name))[2] = auth.uid()::text
  and case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then private.can((storage.foldername(name))[1]::uuid, 'view', auth.uid())
    else false end
);
```

## 20261105100000_restitch_bucket_retirement.sql

Reserved for the approved deletion of the legacy `team-restitch-images` objects
(feature 030, release C). Not written yet; it will carry an explicit object list
and no bucket-wide delete. Deleted objects cannot be restored, which is why the
list is approved first.

## 20261008120000_team_agent_transfer_safety.sql

Forward-fix only after use. Retain same-day audit placements, task account
snapshots, transfer events and finance receipts. Do not restore strict
`ends_on > starts_on` over audit-only zero intervals, and do not grant the
unguarded eight-argument finance setter to authenticated clients. A reverted
web build must leave financial editing unavailable until a placement-aware
client is restored. Preserve task tags and their historical account filter;
removing the snapshot columns would rewrite history on the next transfer.
Deploy the new migration and the placement-aware web client together.

## 20261009100000_team_agent_finance_backdating.sql

Forward-fix only after historical entries have been written. The initial
placement starts at `0001-01-01` as a technical lower bound, not an asserted
account creation date. Do not restore registration-date boundaries over
backdated finance values or alter transfer boundaries. Preserve placement IDs,
versions, finance receipts, amounts and audit events. Rolling back the UI alone
does not remove historical data or require deleting it.

## 20261009110000_team_task_copy.sql

Disable clipboard pasting in the web client before dropping
`public.copy_team_tasks(uuid, uuid[])`. Preserve already-created task copies,
their labels, attachments and audit records. The RPC copies attachment
references, never Drive files, and its batch is atomic.

## 20261128100000_media_companion_projection.sql

Feature 012 (T003/T004/T007). Re-apply `public.list_team_folder_page` from
`20260918160000_folder_page_companions.sql`, `public.search_materials` from
`20260918100000_search_by_word_start.sql` and `public.service_link_transcript_companion` from
`20260902090000_retired_companion_leaves_drive.sql`; then drop
`public.find_reusable_transcript(uuid, uuid)`, `private.has_readable_transcript(uuid, uuid)` and
the index `team_materials_active_checksum_idx`. A web build that calls
`find_reusable_transcript` treats a missing function as "nothing to reuse" and transcribes as
before. Fingerprints already stamped on videos stay; they are harmless data.

## 20261201100000_smarter_material_search.sql

Space search rework (weighted document, name-first ranking, infix and typo tolerance,
`p_recursive`, `matchedIn`/`snippet`). To roll back:

1. `drop function public.search_materials(uuid, text, jsonb, integer, integer, text, text[], boolean);`
   then re-apply `public.search_materials` from `20261128100000_media_companion_projection.sql`
   together with its revoke/grant (`revoke all … from public, anon, authenticated, service_role;
grant execute … to authenticated`) and the comment from `20260827108000_team_search_scope.sql`.
   A web build that asks for `p_recursive` gets PGRST202 and retries without it (direct-children
   scope); rows simply lack `matchedIn`/`snippet`.
2. Re-apply `private.refresh_team_material_search()` from `20260916220000_material_notes.sql` and
   backfill the unweighted vector with the same trigger-silencing DO block this migration uses
   (disable `team_materials_set_updated_at`, `team_materials_thumbnail_state`,
   `catalog_material_mutation`; `update … set search_tsv = <old expression>`; re-enable). Leaving
   the weighted vector in place is also harmless: the old search ignores weights.
3. Optional cleanup: `drop function private.material_search_document(text, text[], text, text,
text, text, text)`, `private.name_fuzzy_match(text, text)`, `private.name_similarity(text,
text)` and `drop index if exists public.team_materials_name_trgm_idx`. Keep the `pg_trgm`
   extension; other objects may come to depend on it.

## Launches — 20261201110000 / 111000 / 112000

Local rollback only after exporting any wanted Launch history: revoke the new Launch RPCs,
remove `team_launch_signals` from `supabase_realtime`, drop new public/private Launch functions
with their exact signatures, then drop `team_launches` active-revision FK and the new
`team_launch_*` tables in dependency order. No existing Tasks/accounts/materials/catalog data
is removed. Production rollback is an additive corrective migration, never rewriting these
files or deleting historical results. No production migration is applied by this implementation.

## 20261202121000_transfer_grant_retention.sql

Stop `soty-transfer-grants-retention` first with `cron.unschedule` for that exact
job. The cleanup function/index can remain, or drop
`private.cleanup_team_transfer_grants(integer)` and
`private.team_transfer_grants_retention_idx` after the job has stopped.
If removing the full index, restore the previous expiry index on `expires_at`
where `revoked_at is null` first. Already-cleaned expired tickets cannot be
restored by rollback. No material,
operation or stored file is deleted by the function.

## 20261202120000_landing_grant_reuse.sql

Redeploy the previous `drive-transfer` source to resume random tickets. Keep the
additive service-only RPC, nullable reuse key and index until no function uses
them; existing grants remain consumable through their hashes and expire normally.
Do not remove grant rows or user data as a rollback.

## Launches — durable catalog / coordinator / defaults / diagnostics (20261201113000, 122000–125000)

These are additive implementation migrations, not a production deployment. Before any local rollback, stop the Launch executor and settle pending intents/cleanup; preserve its receipts until every owned resource is reconciled. Never infer ownership from a name or delete resources belonging to published/historical revisions.

For a local-only rollback, revoke/drop the new `service_*catalog_intent`, `service_plan_catalog_resources`, `service_reconcile_catalog_result`, `service_retry_catalog_child` and `service_*launch_generation`/`service_attach_launch_catalog` routines by their exact signatures in these files; then drop `private.catalog_generation_sharing` before `private.catalog_generation_intents`. Restore the preceding analytics guard from `20261117100000_analytics_guard_contract.sql` only together with a compatible client; drop `public.analytics_launch_generations` and its read-only grant; remove the defaults validation trigger before its private function. Existing Tasks, catalogs, materials and Drive files are retained. A production correction would be a new forward migration, not rewriting applied SQL or destroying historical results.

## Launches — projections, source identity and replay corrections (20261201126000–135000)

Keep existing catalog/material/Drive resources and all immutable Launch revisions. Local rollback
requires stopping the Launch executor before dropping the new restore/reuse RPCs by their exact
signatures. Restore previous source/list/detail function definitions only with the matching web
build. Remove the Launch workspace invalidation publication entry before its signal table; remove
the material-operation/updater/reference guard triggers before their private guard functions.
Dictionary normalization correction and protected resume fields can remain with older clients.
Never drop the catalog intent journal while an unpublished output or uncertain permission needs
reconciliation. Production corrections must be forward migrations.

## Launches — provider-free hosted settlement (20261201136000)

Stop the scheduled catalog updater before rolling back locally. Restore
`private.invoke_catalog_updater_worker()` from `20261127100000_restitch_cache_cleanup.sql`,
then drop `public.service_settle_launch_batch(integer)` and `private.launch_settlement_due()`.
Use the matching prior worker build. Existing completed results and cancelled states remain;
this path neither deletes Drive files nor rolls back permissions. It does not resolve uncertain
provider work, which must retain its journal for ownership-aware cleanup.

## Launches — fault isolation, cleanup claims and recovery dispatch (20261201137000–139000)

Stop both hosted recovery endpoints before any local rollback. Keep all cancellation journals,
sharing receipts and provider IDs until cleanup is settled. Roll back the worker/drive-ops build
together with the exact service cleanup/list-recovery routines; restore the previous scheduler
definition (136000) before dropping `private.launch_cleanup_due()` /
`private.launch_catalog_recovery_due()`. Do not delete registered catalogs or materials.
`service_finish_launch_cleanup` deliberately preserves unknown permission/create outcomes
in `canceled_with_cleanup_pending`; rollback must not relabel them canceled. Unknown causes
are stored as closed codes, never SQL exception text. Production corrections remain forward-only.

## Launches — restitch preparation and settlement (20261201141000–146000)

For a local rollback, stop Launch execution and use the matching prior worker/web build.
Restore the previous settlement wakeup predicate and catalog attach definition before dropping
`service_settle_launch_restitch_batch(integer)`, `settle_launch_restitch(uuid,uuid)` and the
private settlement routine. Remove the reserved-key start and cancellation triggers before
their functions. Keep `private.launch_restitch_preparations` until every bound operation and
uncertain output is reconciled. Preserve generated videos, catalogs and immutable revisions;
rolling back must never turn a canceled parent into accepted work. Production corrections
remain forward migrations. The latest-secret worker readiness correction may remain.

## Launches — local runner, retry and immutable video reuse (20261201147000–151000)

Use a matching older web/worker build and stop Launch executors before local rollback.
Restore the previous catalog recovery list, attach and receipt definitions before removing
`service_link_launch_restitch_catalog`, `get_launch_restitch_reuse` and the private reuse
predicate. Restore the prior detail projection and bind implementation before removing
`process_attempt` or the explicit retry RPC. Retain all preparation rows, prior attempt steps,
copy ledger rows and historical material identities; do not detach or trash videos shared by
multiple Launch revisions. Completed copy ownership stays with its original catalog while
new immutable Launch catalog references record reuse. Production corrections remain forward-only.

## Launches — retention, publication and retry fences (20261201152000–160000)

Stop Launch executors and ordinary cleanup workers before a local rollback. Restore
matching prior claim/retention, material write/trash, ancestor-lock, catalog-link,
publication and unlock routines together with their matching web/worker build.
Do not remove retention guards while any immutable revision references its files
or while an unpublished output is unresolved. Preserve cancellation journals,
restitch preparations, attempt steps and catalog reservations. Unknown outcomes
must stay unsettled; do not relabel partial/interrupted work as editable or canceled.
Keep checksum identity receipts and prior manual revisions intact. Restore the
previous override validation only with a compatible client; larger saved SUB values
remain historical data. Production correction is forward-only and never deletes
historical catalogs or videos as a rollback side effect.

## Launches — working copies, frozen resources and request cancellation (20261201161000–172000)

Stop matching Launch executors before local rollback and restore the matching
web/worker build, analytics guard and diagnostic view together. Preserve immutable
manual revisions, frozen catalog checkpoints, registered output references and
canceled-request tombstones. Never remove the acceptance fence while late or
uncertain acceptance requests can still arrive: that would resurrect canceled work.
The unfenced acceptance function is intentionally not callable by service_role;
only the fenced wrapper is exposed. Restore the wrapper and grants as one unit.
Do not remove registered-output retention while a catalog or video remains in the
workspace, and do not trash historical resources as a rollback side effect.
Production corrections remain forward-only.

## Launches — preparation receipts, bounded steps and authority loss (20261201173000–176000)

Stop the matching recovery worker before local rollback. Preserve recorded failure
causes and step receipts; never reinterpret failed preparation as unaccepted work
or a revoked actor as permission to publish. Restore the preparation wrapper and
its unchecked-function grants together; browsers must never bypass the wrapper.
Restore the recovery predicate, dispatcher due predicate and authority-settlement
call as one compatible unit. Authority loss does not prove native termination or
provider cleanup. Keep those receipts pending until their independent proof exists.

## Launches — existing-installation error vocabulary (20261201177000)

This additive migration synchronizes the closed error vocabulary for installations
that applied the older seed. Keep the codes while matching web, worker or stored
diagnostic receipts reference them. Do not remove historical failure evidence;
production vocabulary corrections remain forward-only.

## Launches — cleanup lease presence (20261201178000)

Keep the cleanup authorization and settlement routines together. Missing owner
or lease expiry explicitly revokes cleanup authority, even with matching fences.
Do not restore the earlier nullable comparison logic: it could authorize a
provider effect after its lease was removed. No historical resources are deleted
as a migration or rollback side effect.

## Launches — restitch upload phase (20261201179000–181000)

Deploy the matching Edge handler and migration together, with older Launch upload
handlers drained before using `not_started` as proof. The marker is private and
nullable: `NULL` means legacy or unknown, `started` means a Drive request may
have happened. Never backfill old rows as `not_started`. Stop the matching worker
before rollback; keep unresolved uploads in cleanup_pending and preserve every
provider/material receipt. Migration 180000 makes missing phase/tool values fail
closed on installations that applied 179000 before its corrected guard.
Migration 181000 serializes the final upload-start authorization against parent
cancellation using the existing launch → generation → child lock order. Keep
that order when changing either path; an earlier authorization order could read
an active parent while cancellation was in progress.

Migrations 182000–183000 add a service-only lease and a marked native-video
cleanup receipt. Stop the hosted worker before rollback. Never clear the private
phase or delete a material as a rollback shortcut: unregistered uploads with
unknown Drive outcomes must remain cleanup_pending. The corrected claim query
in 183000 is also present in 182000 for fresh databases.

Migrations 184000–185000 add the local-upload quiescence receipt and require it
before a provider cleanup claim. Migration 186000 wakes the hosted worker for
quiesced native-video cleanup even without a catalog intent. Restore the prior
`private.launch_cleanup_due()` definition from 138000 if rolling back 186000.
Drain the matching agent version before rollback; a canceled database child
alone does not prove the native uploader has stopped. Preserve pending rows
without a receipt.
Migration 187000 adds a five-minute retry delay for uncertain video cleanup.
Restore `service_finish_launch_video_cleanup` from 182000 only with the worker
stopped; retain the `cleaned` phase until provider-free settlement completes.
Migration 188000 locks new copy requests during generation. Restore `copy_launch`
from 163000 only together with a matching UI; committed request replay is
preserved in both versions and must never create another copy.
Migration 189000 binds a failed Launch catalog child retry to the exact child
attempt that existed when the actor explicitly retried the parent. Stop the
Launch worker before restoring the earlier `retry_launch_generation` and
`service_retry_catalog_child` definitions together. Do not lower an existing
`attempt_no`, clear a registered intent, or retry a terminal child merely to
complete a rollback; preserve its catalog reservation and output receipts.
Migration 190000 keeps a permission in `cleanup_pending` when an `anyone`
grant appears after the provider's create reply was lost. Do not roll this
guard back while such ledger rows exist: the earlier function can relabel an
uncertain grant as preexisting and falsely settle a canceled Launch. Keep the
worker stopped for any function replacement and preserve pending receipts.
Migration 191000 marks grants on a positively trashed, owned unpublished sheet
as cleaned in the same fenced transaction. Grants on source videos and images
remain separate pending receipts. Restore the prior finish routine only with
the worker stopped; preserve existing `cleaned` receipts during rollback.
Migration 192000 adds exact source-permission cleanup behind a service lease,
consumer proof and a short catalog-start fence. Deploy it with the worker that
reads the new permission plans and confirms deletion by listing the exact ID.
Stop that worker before a forward-only correction. Preserve `cleaned`,
`retained` and unknown ledger rows; never replace an unknown lost-create reply
with an assumed owned grant. If the worker is rolled back, leave cancellation
pending rather than deleting a source grant without the matching fence.
Migration 193000 adds the producing `generationId` to the protected revision
projection. A rollback can restore the prior `private.launch_revision_json`
definition from 110000 without data changes, but browser result visibility
then loses its run correlation. Treat delivery as unknown until the projection
and matching web build are restored; do not count revision-only receipts as
proof that a particular generation reached the user.
Migration 20261202123000 enables and forces RLS on the private restitched-folder
registry. Keep it enabled during rollback; the existing security-definer worker
continues to use the table, and no data rewrite is needed.
Migration 20261202124000 exposes only active member IDs and display names to
Launch viewers for assignment controls. Dropping this function requires the
matching web build to stop calling it; keep the stronger member-management
permission on `list_team_members`.
Migration 20261202125000 factors the existing copy date calculation into
`private.launch_tomorrow` so deterministic timezone boundaries can be tested.
Restore the previous `copy_launch` definition from 188000 before dropping
that helper; committed copy receipts must remain unchanged and replayable.
Migration 20261202126000 makes the restricted Launch diagnostic view return a
non-null active-result flag for drafts and failed attempts. Do not restore the
nullable expression from 172000 while the read-only CLI expects a boolean;
keep the view content-free and repair it forward instead.

### 20261202132000_launch_dictionary_management

Drop `public.edit_launch_dictionary(uuid,text,uuid,text,text,text,text)` to remove
management writes. Restore the prior analytics guard from
`20261201172000_launch_cancel_diagnostic_code.sql` only after rolling back clients.
Dictionary rows and revision snapshots are retained; no data rollback is required.

### 20261202134000 — Launch restitch pool scope

Reapply `prepare_launch_restitch_unchecked` from
`20261202133000_launch_automatic_restitch.sql` to roll back the function change.
Also restore `private.launch_restitch_settings_version` from
`20261201131000_launch_content_identity.sql`, then drop the private helper
`private.launch_restitch_pool_user(uuid,uuid)`. No rows are changed. The rollback restores the known
incorrect personal-pool lookup for inherited settings; prefer a forward fix.

### 20261202135000 — Launch reuse input identity

Prefer a forward fix: restoring the old guards reintroduces stale duration reuse.
If required, restore only `private.launch_reusable_restitch` from
`20261201151000_launch_restitch_reuse.sql` and `public.service_reuse_launch_catalog`
from `20261201132000_launch_content_reuse.sql`, then drop
`private.launch_restitch_config_identity(jsonb)`. Keep the additive diagnostic
`reuse_evidence` column and provenance index; old CLI versions ignore them, and
Postgres cannot remove a view column through CREATE OR REPLACE VIEW. This
migration changes no stored revisions, settings, files, or generation states.

### 20261202136000 — Launch reuse checkpoint

Restore only `public.service_reuse_launch_catalog` from
`20261202135000_launch_reuse_input_identity.sql`. This preserves the corrected
input guards but restores the premature catalog-registering checkpoint. No data
changes need reversing.

# 039 Catalog manager profiles (`20261203110000_catalog_manager_profiles.sql`)

This migration copies each catalog's effective content switches into
`team_catalog_update_profiles`. Before reverting, export those rows: reverting loses
independent per-catalog choices and attempt history. Drop the
`analytics_catalog_updates` view, `retry_team_catalog_update`,
`cancel_team_catalog_update`, `patch_team_catalog_update_profile`,
`list_team_catalog_update_profiles`, `list_team_catalog_update_attempts` and
`track_catalog_update_result`/`track_catalog_update_round` triggers and functions.
Drop `seed_catalog_update_profile` and its trigger, then the attempt/profile tables
and private `catalog_update_reconciliations` table. Remove the
`reconciliation_required`, `default_restitch` and `last_update_error_at` columns.
Drop the service begin/finish/unknown/claim/resolve reconciliation functions.
Restore all replaced
`private` and `public` updater function bodies from their immediately preceding
migrations, including claim, queue, sync, retry, interval, manual run and
restitch setter. This is a local rollback guide, not an authorization to modify
production data.

## 20261204160000 — Catalog calendar schedules

Prefer a forward correction. Export `team_catalog_update_profiles.schedule` before
any rollback; these are user choices, not disposable cache entries. To disable
calendar execution without deleting choices, replace only the scheduled worker's
`next_catalog_schedule(...)` expression with the preceding elapsed interval
expression. Retain its workspace entitlement, reconciliation, due-time and lease
checks. Restore the preceding profile patch/interval-setter behavior from
`20261203110000_catalog_manager_profiles.sql` if reverting the corresponding UI,
so old clients cannot edit calendar schedules. Keep the additive schedule column,
its validation helper, the appended profile-list field and analytics view fields;
older callers ignore them. Removing view fields requires replacing the view and
its grants/dependencies and is unnecessary for a behavior rollback. Remove the
new timing helper only after no function references it. This guide does not
authorize resetting beta or modifying production.

## 20261204170000 — Authoritative catalog settings observations

Prefer a forward fix. The journal is committed history: export it before any
schema removal, and never recreate historical changes from present-day settings.
To stop capture, disable the five constraint triggers
`catalog_profile_settings_journal`, `catalog_interval_settings_journal`,
`catalog_record_settings_journal`, `catalog_material_settings_journal` and
`catalog_material_deleted_journal` on their profile/item/catalog/material tables.
Keep the private journal, lock-head and installation-metadata tables and the three read-only analytics views;
`analytics_catalog_settings_coverage.capture_enabled` becomes false when any of
those triggers is disabled. Report capture as unavailable from that point rather
than treating the retained latest rows as fresh settings. Re-enabling triggers does not reconstruct changes
during the gap: record fresh observation baselines with an explicit new coverage
boundary through a forward migration before making trend claims again. If full
removal is required, first remove the analytics views and their grants, then the
triggers, `private.track_catalog_settings_observation`,
`private.record_catalog_settings_observation` and
`private.catalog_settings_observation`, then the private tables after exporting
them. No product profile, schedule, material or credential needs to be deleted.

## 20261204180000 — catalog manager active count

Forward-only additive RPC field. To roll back presentation, deploy the prior web; it ignores `activeCount`. If reverting the database separately, restore `public.get_team_catalog_updater(uuid)` from `20260915140000_catalog_updater.sql` (the same authentication/view permission guard and `private.catalog_updater_state(p_team)` return). Do not reset catalog schedules, attempts or history. Apply through the normal release process; local beta application is not production promotion.


## 20261205100000_tariff_catalog_recovery

034 recurring-catalog increment. No new tables or columns. Before rollback stop candidate rollout;
keep current data and profile/calendar schedules. Forward compensation must restore the definitions
of `private.apply_tariff_pauses`, `private.after_space_tariff_change` and
`public.resume_team_catalog_updater` from `20261130110000_space_tariffs_background.sql` /
`20261130100000_space_tariffs.sql`, and `private.catalog_settings_observation` from
`20261204170000_catalog_settings_journal.sql`. Drop trigger `space_tariff_capture_catalog_pause`
on `public.space_tariffs`, then functions `private.capture_tariff_catalog_pause()` and
`private.restore_tariff_catalog_schedules(uuid)`. Previously restored schedules remain active;
do not turn them off or replay their catch-up rounds. Review false preference observations if
restoring the historical observation function. Full one-off/agent recovery has not shipped in this migration.

### 037 workspace UX receipts and image choice (20261205120000–20261205127000)

Forward-only. Before any rollback, stop the existing catalog-updater lane from claiming
new task cleanup and reconcile every `claimed` receipt against the exact Drive object.
Do not clear its reference fence while the provider outcome is unknown. Restore trashed
files only through the ordinary authorized restore flow; never infer reclaimed quota.
Retain task-upload provenance, copy receipts and bulk item keys until all accepted work
has settled and the corresponding client has been rolled back. A compensating migration
may then remove the diagnostic view and revoke the new client/service RPCs, drop the
new receipt tables and their triggers, and restore the previous dispatcher body and
analytics-property guard. Keep every pre-existing catalog/Launch recovery lane. Remove
`task_cleanup_reference_fence` triggers only after no cleanup claim remains. Never drop
`team_operations`, user materials, task links or the existing upload journal. Removing
optional image settings fields does not rewrite historical frozen jobs. Validate the
compensation in an isolated database before any separately authorized release.

## 034 durable recovery and native delegation (20261205110000, 20261206100000–110000)

Stop `soty-workspace-recovery` and the `team-recovery` endpoint before a local rollback. Revoke native
delegations and stop participating agents before restoring older claim/heartbeat routes. Never weaken
current tariff checks while a previously leased worker is running. Keep WorkspacePause/PauseItem,
RecoveryItem, original one-off attempts and operation receipts until every unresolved item is reconciled;
do not delete snapshots to make a rollback appear clean.

Roll the web/agent capability back together with Edge routing. The browser preparer must not compete
with a still-authorized native delegation. Restore the exact pre-migration functions from the prior
migration chain, including catalog settings/attempt hooks and sync dispatch. Retain unresolved private
records; deleting terminal history is only permitted after the documented 30-day retention and no live
updater reference. Vault replay responses and expired credentials can be removed independently after
revocation. Keychain/DPAPI deletion is per explicit installation disable, never a production-wide reset.

These migrations have only local implementation evidence here; this is not a production rollback command.


### 034 late-output fence (`20261206120000`)

Keep the source/version/configuration receipt columns on `private.catalog_restitch_operations`.
They fence promotion of uploaded files after a lease, permission, source or configuration change.
Existing operations without a receipt become retired cleanup entries. Do not roll back to an
unfenced `service_record_restitch_output` while old workers can still finish. The cleanup worker
must deploy with `service_authorize_catalog_cleanup`; a missing/failed authorization stops deletion.
A provider HTTP request already sent cannot be canceled atomically by PostgreSQL: retain its actual
completion receipt even if access closes in flight. Never report such a receipt as a resumed job.

## 20261206140000 — launch offer defaults

Source migration only; no production application is implied. Roll back the web feature first and retain the new table, RPCs, validation and content-free invalidation trigger: older clients continue using the unchanged workspace RPC signature and replay digests. Keeping dormant offer profiles preserves saved settings. Do not drop the table or narrow the budget validator while saved manual-budget profiles exist. A destructive schema downgrade requires an explicit data-preservation plan; ordinary application rollback requires no database writes.


## 20261206140500 — Launch offer defaults reference fence

Retain `task_cleanup_reference_fence` while `team_launch_offer_defaults` exists. It registers this consumer with the existing conservative reference scan and rejects late material references after cleanup has been claimed. An application rollback requires no schema action. Removing or disabling this trigger makes cleanup coverage unknown and retains files as `cleanup_unverified`; do not bypass that check or exempt this table. A complete offer-defaults feature removal must preserve saved profiles as described above. This source fix does not authorize a production migration.
