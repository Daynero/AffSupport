# Catalog manager contracts

## Read model

Registry response adds `profile`, `profileVersion`, `lastVerifiedSuccessAt`, `lastAttempt` (`id`, `trigger`, `stage`, `result`, `startedAt`, `endedAt`, `failureCode`, `deliveryVerifiedAt`), `snapshotAt`, and `nextRunAt`. Response is validated at the API boundary. Unknown stage/result/absence of proof is represented, not silently dropped. List can load in pages while preserving stable catalog IDs and scroll anchor.

## Mutations

- `saveCatalogProfiles(teamId, changes[{catalogId, expectedVersion, patch}])` — atomic per catalog; returns per-catalog accepted/conflict/error and effective profile. Only explicit patch fields change. Bulk action may partially succeed and reports each result.
- `runCatalogNow(teamId, catalogIds, sourceAttemptId?)` — idempotent start, returns existing or new attempt IDs; does not alter `nextRunAt`.
- `cancelCatalogAttempt(teamId, attemptId)` — cancels active attempt only; reports stage and preserved completed output.
- `setCatalogInterval(teamId, catalogId, null)` — disables future scheduled runs only.
- `listCatalogAttempts(teamId, catalogId, limit=10)` — newest first, permission checked.

All writes use existing team permission checks and typed stable error codes. Server owns time and version. Profile snapshot and attempt ID travel through worker and any local restitch dependency.

The local restitch dispatcher receives the catalog's attempt ID and `restitch` snapshot, reports preparation/ready/blocked against that attempt, and must not read a later profile to change an already claimed attempt. Server search/filter covers the entire registry when pagination is used; the response includes total match count.

If the agent is offline, stale or lacks a required image, the table's independent update proceeds. The attempt records `video=blocked` with a stable reason code and an action to reconnect/configure the agent; when the table is verified its terminal result is `partial`. This path cannot be represented as full success or a total table failure.

Delivery verification reads back the same Drive file ID after write and compares a non-content version marker for the expected attempt, confirms the stable sheet link still resolves, then records `delivery_verified_at`. If a readback is unavailable or inconclusive the terminal state is `unknown`, eligible for reconciliation before retry. It is never promoted to success from the write response alone.

## Diagnostics

Signals use `flow_id`, `catalog_id`, `attempt_id`, `profile_version`, `trigger`, `stage`, `terminal_result`, `failure_code`, `delivery_verified`. No names, raw paths, sheet contents, URLs, credentials or provider payloads. Read-only CLI returns stage chain, last proven stage, delivery evidence, and blind spots for catalog/attempt investigation.
