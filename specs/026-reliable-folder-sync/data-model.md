# Data Model: Надійна синхронізація та завантаження вкладених папок

## 1. Catalog sync job

Extends the existing private catalog job. It remains unavailable to browser roles; callers receive a safe projection.

| Field                                      | Meaning                                                                     | Rules                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `id`                                       | Stable job identity                                                         | UUID, immutable                                                            |
| `connection_id`                            | Storage connection                                                          | Required; cascade cleanup with connection                                  |
| `job_kind`                                 | `incremental`, `initial`, `user_subtree`, `discovered_subtree`, `reconcile` | One canonical active `incremental` per connection; subtree jobs are finite |
| `scope_folder_id`                          | Root of a finite scan                                                       | Required for subtree jobs; absent for connection-wide job                  |
| `requested_by`                             | User who requested manual work                                              | Present only for user work; membership/role rechecked when requested       |
| `phase`                                    | `initial_scan`, `change_replay`, `incremental`, `reconcile`                 | Valid transitions below                                                    |
| `state`                                    | `pending`, `leased`, `retry`, `succeeded`, `failed`, `canceled`             | Finite jobs terminate; canonical incremental returns to pending            |
| `cursor`                                   | Current provider page/change position                                       | Validated object; finite work never commits connection cursor              |
| `folder_queue`                             | Durable breadth-first queue                                                 | Array of provider folder ids, bounded per checkpoint                       |
| `failure_count`                            | Consecutive failed executions                                               | Resets on successful checkpoint/complete; bounded retry policy             |
| `run_count`                                | Diagnostic number of claims                                                 | Never used as a failure ceiling                                            |
| `priority_class`                           | User/discovery/initial/background ordering                                  | Used with fairness, not absolute starvation                                |
| `lease_owner`, `lease_expires_at`          | Worker authority                                                            | Mutation requires matching unexpired lease                                 |
| `next_attempt_at`                          | Earliest eligible claim                                                     | Honors provider backoff                                                    |
| `last_error_code`                          | Stable failure code                                                         | Null after confirmed successful progress                                   |
| `created_at`, `updated_at`, `completed_at` | Lifecycle timestamps                                                        | Terminal finite job has `completed_at`                                     |

### State transitions

```text
pending ──claim──> leased ──checkpoint/yield──> pending
                      ├──retryable error──────> retry ──claim──> leased
                      ├──finite complete──────> succeeded
                      ├──permanent error──────> failed
                      └──cancel───────────────> canceled

incremental leased ──successful poll──> pending (failure_count = 0)
```

### Invariants

- A partial unique constraint permits one non-terminal `incremental` job for an active connection.
- Active scopes deduplicate independent of reason. Join an ancestor only if its branch is still ahead; otherwise retain one follow-up. Connection lease epoch fences every catalog commit.
- Only the canonical incremental job may advance `team_drive_connections.change_page_token`.
- Successful no-change polling is success, not retry consumption.

## 2. Catalog scan seen entry

Private, short-lived staging used to prove exact direct-child membership across provider pages and worker restarts.

| Field              | Meaning                              | Rules                    |
| ------------------ | ------------------------------------ | ------------------------ |
| `job_id`           | Owning scan                          | Required; cascade delete |
| `parent_folder_id` | Folder being listed                  | Required                 |
| `drive_file_id`    | Direct child observed                | Required                 |
| `observed_version` | Optional provider version/checkpoint | Diagnostic only          |
| `seen_at`          | Observation time                     | Required                 |

Primary key: `(job_id, generation, parent_folder_id, drive_file_id)`. Generation records a catalog baseline; rejected page tokens restart it.

Generation stores the baseline mutation revision and coverage status. A separate
private frontier stores `(job, generation, folder, parent, state)` with closed
states `queued`, `listing`, `reconciling`, `done`. Checkpoints carry a bounded
frontier page; remaining rows stay durable and are never dropped at a queue cap.
Only the current connection lease epoch may commit; provider I/O runs outside
the transaction. Confirmed cursor provenance belongs to the canonical job;
ambiguous historical tokens require reconciliation, never token comparison.

Final pagination creates candidates only. Recheck current provider parent/trash; commit checks lease epoch and unchanged catalog baseline. Ambiguous 403/404 is unavailable. Incomplete/malformed pages never prove absence; completion waits for canonical replay. No browser access or Realtime publication.

## 3. Storage connection sync health

Existing connection gains explicit health/progress semantics.

| Field                | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `coverage_state`     | `unknown`, `complete`, `partial`, `permission_limited`         |
| `sync_health`        | `current`, `working`, `delayed`, `needs_reauth`, `failed`      |
| `last_reconciled_at` | Last provider position successfully committed by canonical job |
| `last_progress_at`   | Last confirmed checkpoint, including subtree work              |
| `last_error_code`    | Current actionable stable error                                |

An empty catalog is valid only when coverage is confirmed for the selected root. Existing indexed rows remain readable when health degrades.

## 4. Catalog event

Existing `team_catalog_events` remains the low-volume invalidation stream and gains enough scope for targeted catch-up.

| Field              | Meaning                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `id`               | Unique invalidation identifier; never a replay cursor or commit watermark                                     |
| `team_id`          | RLS/filter boundary                                                                                           |
| `material_id`      | Affected material when known                                                                                  |
| `parent_folder_id` | Folder page to invalidate when known                                                                          |
| `operation_id`     | Related workspace/Drive operation when known                                                                  |
| `event_kind`       | `upserted`, `tombstoned`, `restored`, `sync_state`, `folder_indexed`, `storage_state`, existing preview kinds |
| `occurred_at`      | Ordering/diagnostic time                                                                                      |

Events are invalidations. Material names, content, credentials and local paths do not travel in the event; the client rereads authorized catalog projections.

## 5. Local transfer manifest

Ephemeral browser model created before a workspace operation starts.

```text
LocalManifest
├── roots[]: clientKey, kind, name
├── entries[]
│   ├── DirectoryEntry: clientKey, relativePath, depth
│   └── FileEntry: clientKey, relativePath, sizeBytes, mimeType, File source
├── issues[]: relativePath?, stableCode, recoverable
├── totalFiles
├── totalDirectories
└── totalBytes
```

### Validation

- `relativePath` uses `/`, is relative, Unicode-normalized for comparison without rewriting displayed name, and contains no empty/`.`/`..`/NUL segment.
- Root names are included exactly once; directories exist as entries even when empty.
- `clientKey` is unique inside the manifest and stable across a retry of the same normalized path/type/size.
- Depth, entry count, individual file size, total size and segment/path length use existing product/provider limits. Exceeding a limit creates a visible manifest issue before remote mutation.
- Cyclic/repeated directory handles are not traversed twice.
- Relative group metadata is persisted locally only. File, handles and absolute paths are not journaled. Individual existing material operations remain server-authoritative.

## 6. Local operation journal

Actor/team-scoped IndexedDB metadata only. No new public group/item tables.

- Group: id, actorId, teamId, kind (upload/move/sync), frozen destination,
  state (preparing/running/partial/succeeded/failed/canceled/interrupted_input_required),
  stage (preparing/creating_folders/transferring/moving/updating_catalog/done),
  attempt, timestamps and local ownership lease.
- Item: client key, relative path, parent key, original name, size, kind,
  existing material operation/idempotency ID, result material ID,
  state (pending/running/succeeded/failed/skipped/canceled/input_required), error.
- Memory-only: File/handle sources, byte offsets and denominator.
- Checkpoints on acceptance and confirmed item transitions, never byte callbacks.
- Recovery queries known material operation IDs before retry. Unfinalized uploads
  need reselection and a new byte-zero attempt even if path/size matches.
- Retention seven days terminal, thirty interrupted. Sign-out purge; quota
  failure exposes session-only recovery. Other accounts cannot read the journal.

## 7. Retention

Seen rows are removed after reconciled folder; failed/canceled generations at
terminal cleanup; orphan staging after 24h without live lease. Terminal finite
jobs live seven days with cleanup batches ≤500. Canonical jobs/cursors remain.
Existing catalog-event/material-operation retention is unchanged. No replay
cursor or server progress history is introduced.
