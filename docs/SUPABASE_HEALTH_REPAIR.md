# Supabase: transfer grant growth investigation

Read-only production inspection on 2026-10-12. No production data was changed.

## Findings

- Database: 705,244,307 bytes; transfer grants: 499,605,504 bytes including
  185,737,216 bytes of indexes. Catalog row estimates were clearly inconsistent
  with exact aggregates, so they must not be used as actual record counts.
- 1,221,723 grants were `preview_range` tickets for `landing-render` images of
  just 94 materials. 1,221,441 were unused; 1,221,552 expired. 53,157 were minted
  in the preceding day. These are permission hashes, not saved image content.
- `BackgroundRenderProvider.findCandidate` polled every minute using
  `teamApi.listLandingRenders`. That method also called `landing_render_tokens`
  for every ready render, inserting tickets even though the worker needed only
  status. Expired grants had no retention job. This explains the runaway table.
- Other largest relations: `cron.job_run_details` ~59 MiB, `team_materials`
  ~46 MiB, `analytics_events` ~30 MiB, `storage.objects` ~14 MiB,
  `team_catalog_events` ~11 MiB. Size does not establish that their data is
  disposable; no files, catalog, audit, analytics or storage metadata are removed.
- Direct read-only queries succeeded during the inspection. Browser/agent
  connection analytics are a different connection, and cannot establish a
  Supabase outage. Historical Disk I/O budget and the failing Auth/REST request
  are not in that telemetry. Supabase documents depleted I/O budget as a cause
  of API degradation, but the exact reported connection failure remains unproven.
  The final check reported both Auth and REST as `ACTIVE_HEALTHY`, with 20
  database sessions against `max_connections = 60`. Cron history had 333,614
  records, of which 94,402 completed more than 30 days ago.

## Production repair, 2026-10-13

The server-only repair is deployed from isolated commit
`66333fd4f5eafdcc85736b30afc2bea7767fb829`, based on released `v1.2.6`.
`drive-transfer` now reconstructs and reuses matching idle landing preview grants
instead of inserting a new grant on every poll. Expiry, eight-use budget,
revocation and current-permission checks remain enforced. Uploads and legacy
random tickets retain their existing behavior. See
[the grant hotfix](SUPABASE_GRANT_HOTFIX.md) for scope and rollback.

Migration `20261202120000_landing_grant_reuse.sql` adds the service-only issuer
and an index over reusable idle grants. Migration
`20261202121000_transfer_grant_retention.sql` replaces the old partial expiry
index with a full expiry index and schedules at most 500 deletions every five
minutes, only for tickets expired more than one diagnostic day ago. Materials,
operations, audit records and Storage objects are preserved. No unbounded DELETE
or VACUUM FULL is used. The initial backlog needs roughly nine days at this rate;
DELETE does not guarantee immediate physical disk shrinkage.

The canonical backend apply pushed both migrations, then its verification
connection briefly failed. A freshly derived recovery plan confirmed no pending
migrations and deployed only `drive-transfer`. Both durable journals and the
verification evidence are kept under `release/automation/backend/`:

- `backend-2026-10-13T07-41-42-309Z`: initial migration write boundary.
- `backend-2026-10-13T07-43-01-804Z`: function deployment, reported observed.

At 07:43:43 UTC all three retention jobs were active and successful. The grant
job had deleted its first 500 expired rows. The new reuse index recorded 47
production lookups; its RPC and both new indexes were present, and the previous
expiry index was absent. Auth and REST remained `ACTIVE_HEALTHY`. This proves
activation; it does not measure long-term I/O savings or establish the historical
connection failure's exact cause.

Full isolated `npm run verify` passed all 14 gates: 4,873 tests, 20 documented
skips, no failures. Focused real-SQL, crypto and analytics regressions also passed,
including the full adversarial transfer fixture in the original workspace.
No desktop or web build, version bump or full release was performed. Unrelated
pending migrations and working-directory changes were excluded from deployment.

The status-only web fix remains local: background polling requests
`includeArtifacts: false` while visible galleries retain ticket fetching.
Shipping it in a later web deployment eliminates background ticket requests
entirely. The current server repair already works with existing clients.

## Monitoring and remaining work

`npm run analytics -- database-retention --json` reads cleanup job outcomes,
index/RPC presence, cumulative grant inserts/deletes/reuse-index scans and current
Auth/REST health without scanning user or grant tables. Counters are cumulative
since the statistics reset; compare timed snapshots rather than treating them as
a per-period count.

`database-health --management --json` obtains on-demand purpose/producer/expiry
aggregates using read-only management queries. Full aggregates scan the grant
table and must not be polled frequently. Neither diagnostic exposes token hashes,
actor IDs, paths, content or credentials.

The seven-day completed cron/catalog retention and redundant tenant index repair
are already deployed; see [the table audit](SUPABASE_TABLE_AUDIT.md). Storage
objects still referenced by configuration are retained. Confirm the post-cleanup
allocated size before asserting that the Free plan will fit. Any physical
compaction or legacy Storage migration is separate work with its own evidence.
