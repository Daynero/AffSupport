# Supabase table and Storage audit — 2026-10-12

Read-only production inspection through `npm run analytics -- database-tables --json`.
The command inventories the 25 largest non-transfer-grant relations with exact
counts, the 40 largest non-grant indexes and equivalent index definitions.
Other relation sizes were already inspected with `database-health`. No production
records, files, policies, indexes or schedules were changed.

## Production follow-up — 2026-10-13

The operational-history repair is deployed independently of clients and Launches,
from released `v1.2.6` on branch `fix/db-history-retention`, commit `dec355258b90`.
The canonical backend plan contained only `20261202110000` and `20261202111000`;
both are confirmed applied. No web/desktop packages, tags, manifests or user files
were changed by this deployment.

At 06:51 UTC both new jobs were active and their first executions succeeded:
catalog cleanup at 06:50, cron cleanup at 06:47. Database counters confirmed
**50 catalog signals and 500 completed cron records deleted**. The catalog
expiry index exists; the original tenant key is present and its duplicate is
absent. The seven-day policies are active; the historical backlog drains
gradually. DELETE does not immediately shrink allocated database files.

Verification: 4,850 tests passed, 20 documented skips, zero failures in the full
suite retry. All 13 static gates passed after the managed-cron permission fix.
Targeted SQL tests additionally passed with a non-owner maintenance role,
preserving active runs, recent history, audit records and FK enforcement.
Initial migration attempts failed transactionally on managed-table index
ownership; the final patch reuses the managed primary key and does not change
system ownership or privileges.

Use `npm run analytics -- database-retention --json` to check job results and
cumulative deletion counters without scanning application or grant tables.
The transfer-grant producer repair remains separate. This deployment implements
the two approved seven-day history policies and removes the duplicate index.

## Confirmed findings

| Relation / storage purpose     | Observed                                   | Assessment                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cron.job_run_details`         | ~61.5 MB, ~333,700 records                 | No cleanup found. ~297,500 completed records are older than 7 days; their row content is ~42.8 MB excluding index/page overhead. Retaining 7 days could reclaim roughly 50 MB after appropriate physical maintenance; retaining 30 days saves less. Approval of the diagnostic history policy is still needed. |
| `public.team_catalog_events`   | ~11.3 MB, 61,326 records                   | Append-only invalidation signals; no retention found. 49,184 older than 7 days (~3.9 MB row content). Realtime consumers re-read authoritative state; no historical SQL replay consumer found. Add bounded retention after defining the horizon. Audit history lives separately and must be preserved.         |
| `public.team_materials`        | ~47.8 MB, 14,299 records, ~30.2 MB indexes | 13,308 active, 677 missing, 314 trashed. Largest GIN index ~10.4 MB indexes ~5.3 MB of search vectors and has observed reads. Size is not evidence of garbage. Missing/trashed material metadata can still be necessary; never delete based only on lifecycle.                                                 |
| `public.analytics_events`      | ~31.7 MB, 39,397 events                    | 90-day retention and daily materialization are configured. Oldest observed event is 2026-07-18, still within 90 days. No urgent excess found.                                                                                                                                                                  |
| `public.team_product_catalogs` | ~5.5 MB, 163 records                       | Contains real catalog payloads (~4.1 MB row content). No disproportionate accumulation demonstrated.                                                                                                                                                                                                           |
| `storage.objects`              | ~14.5 MB metadata, 8,009 objects           | Distinct from the ~450 MB stored file content; SQL metadata deletion is not a safe way to remove physical files.                                                                                                                                                                                               |
| Thumbnail cache                | 7,904 files, 228,057,394 bytes             | Backend still has a legacy-cache read fallback. Current versions/references must be checked before expiring cache entries; do not assume all are obsolete.                                                                                                                                                     |
| Legacy re-stitch images        | 105 files, 221,735,616 bytes               | One of two space default configurations still uses legacy mode with image IDs. Zero member preferences use it. Whole-bucket removal is unsafe; migrate the remaining configuration and inventory objects individually first.                                                                                   |

One exact duplicate unique index pair was found on `team_account_agents`:
`team_account_agents_id_team_unique` and `team_agents_tenant_key`, both `(id, team_id)`.
They came from different feature migrations. This is a small structural redundancy,
not a material source of the database size. Check foreign-key dependencies before
consolidating constraints; do not drop either blindly.

Scan state tables are around 1 MB each. The 2,172 generations are completed scans
belonging to finite jobs; a bounded retention function already exists. The small
size does not justify aggressive cleanup. Operations, audit records, intentions
and auth tables are also small compared with the transfer-grant problem.

## Limits and next work

Owner decision, 2026-10-12: retain `public.team_catalog_events` for **7 days**.
Implement bounded cleanup of older invalidation signals, preserving the separate
audit history. Verify reconnect/current-state reads and Realtime behavior during
cleanup. This approved horizon is implemented by the deployed repair above.

The owner subsequently approved **7 days for all completed cron runs**, including
failures. Migration `20261202110000_operational_history_retention.sql` now
implements both policies: at most 50 catalog signals and 500 terminal cron
records per call. Catalog expiry uses an index and `SKIP LOCKED`; cron history
reuses its managed primary key and an advisory transaction lock, without
requiring ownership or UPDATE privilege on Supabase's cron table. Two staggered
five-minute schedules drain the old backlog gradually. Nonterminal cron records,
null completion times, audit records and recent history are preserved. Local
Realtime subscriptions consume INSERT only, so retention deletes do not cause
catalog reads after the web update. Existing clients still receive deletes;
the smaller catalog batch bounds that transitional load.

Real SQL regression tests verify the retained horizon, active runs, both batch
ceilings and permissions. Installation schedules cleanup but does not delete the
entire backlog in the migration transaction. Production application remains
subject to the canonical backend plan and verification gates.

Migration `20261202111000_agent_tenant_index_dedup.sql` checks that the two tenant
unique indexes are equivalent and valid, then removes only the unreferenced
duplicate. If a foreign key depends on that duplicate it is retained, without
CASCADE or re-creating user relationships. Both dependency cases have regression
coverage and retain uniqueness and foreign-key enforcement.

PostgreSQL activity counters have clearly incomplete/reset history: their live-row
estimates differ from exact counts. An index with zero observed scans is not
proven unnecessary. `pgstattuple_approx` is not installed, so this audit does not
claim an exact dead-tuple/free-space or index-bloat measurement. The row-size sum
is not equivalent to heap size and may include different treatment of TOAST.

The completed cron/catalog retention is deployed. On 2026-10-13 the isolated
server transfer-grant repair and bounded expired-ticket retention were also
applied; see [the hotfix](SUPABASE_GRANT_HOTFIX.md) and
[production evidence](SUPABASE_HEALTH_REPAIR.md). Physical disk recovery needs a
separate maintenance plan; DELETE alone does not immediately shrink files.

Storage work is a separate migration: preserve referenced legacy images, move
the remaining legacy configuration to Drive, classify old cache versions and
delete only an approved object list through the Storage API. Never remove
`storage.objects` rows directly as a substitute for object deletion.

The extended read-only CLI passes focused lint and regression tests. The initial
audit was read-only; the approved production follow-up is recorded above.
