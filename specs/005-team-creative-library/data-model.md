# Phase 1 Data Model: Team Space / Creative Library

This model extends feature 001. Existing `teams`, `team_members`, Drive connections,
`team_materials`, operations, transfer grants, provenance, catalog sync and audit remain
authoritative. Google Drive owns bytes; Postgres owns stable relations and state.

All ids are UUID, timestamps are `timestamptz`, external provider ids are opaque text, and
new public/private tables enable and force RLS. Client writes occur only through narrowly
granted caller-checked functions.

## Shared enumerations and limits

- `LibraryStage`: `finds | library`
- `PlacementSegment`: `stage | offer | language | type`
- `MaterialCategory` (canonical `structural_type` source): `video | image | archive | transcript |
  landing | other`; a file that fits no specific category resolves to the catch-all `other`. The
  `Type` folder segment is `initcap(MaterialCategory)` (e.g. `Video`); `Unknown` is the FR-022
  placement used only when no category exists yet (null category).
- `PlacementState`: `unplaced | planning | moving | ready | reconciling | failed`
- `EnrichmentKind`: `language | thumbnail | landing_preview`
- `EnrichmentState`: `pending | running | ready | unknown | failed | stale | canceled`
- `LibraryJobKind`: `transcription | translation | landing_optimization`
- `LibraryRequirementState`: `pending | leased | running | ready | failed | canceled | stale |
skipped`
- `LibraryAttemptState`: `leased | running | ready | failed | canceled | expired | skipped`
- `LibraryResultState`: `current | stale | superseded`
- `TaskStatus`: `todo | in_progress | done`
- `ContributionCategory`: `local_processing | human_activity`
- `TaskProgressMax`: integer 1–10,000; value integer 0–max
- `UPLOAD_BATCH_MAX_SELECTION >= 100`; transport still uses bounded individual/resumable
  operations
- `ATTACH_MUTATION_BATCH_MAX = 100`; repeated batches have no product-level total cap
- `LIBRARY_JOB_LEASE_SECONDS <= 120`; heartbeat extends one operation only
- video thumbnail target = 1,000 ms; shorter media uses its final available instant

## Extensions to Material

`team_materials` gains:

| Field                        | Type             | Rules                                             |
| ---------------------------- | ---------------- | ------------------------------------------------- |
| `library_stage`              | text nullable    | `finds                                            | library`; null for pre-library/folders |
| `structural_offer`           | text nullable    | normalized team value or `unknown`                |
| `structural_language`        | text nullable    | controlled language or `unknown`                  |
| `structural_type`            | text nullable    | `initcap(MaterialCategory)` (Video/Image/Archive/Transcript/Landing/Other) or `Unknown` |
| `placement_state`            | text             | closed state, default `unplaced`                  |
| `placement_revision`         | bigint           | increments on every manual structural decision    |
| `language_decision_source`   | text nullable    | `manual                                           | automatic                              | unknown` |
| `language_decision_revision` | bigint           | fences late automatic commits                     |
| `thumbnail_state`            | text             | closed enrichment state                           |
| `thumbnail_source_version`   | text nullable    | current only while source matches                 |
| `thumbnail_time_ms`          | integer nullable | `1000` for normal video, final instant if shorter |

Structural metadata does not replace existing GEO/language/offer/tags. Existing controlled
metadata remains searchable; placement records the physical Library path decision.

## CanonicalLibraryFolder (`private.team_library_folders`)

| Field                             | Type             | Rules                             |
| --------------------------------- | ---------------- | --------------------------------- |
| `id`, `team_id`, `connection_id`  | uuid             | one connected team root           |
| `parent_folder_id`                | text             | verified parent Drive id          |
| `segment`                         | PlacementSegment | depth-specific                    |
| `value`, `normalized_key`         | text             | bounded display + case-folded key |
| `drive_folder_id`, `resource_key` | text             | provider identity                 |
| `state`                           | text             | `creating                         | ready | missing | failed` |
| `verified_at`, timestamps         | timestamptz      | freshness                         |

Unique `(team_id,parent_folder_id,segment,normalized_key)` and `(team_id,drive_folder_id)`.
Only service functions can read/write provider ids. Missing/external moves are reconciled;
the table never authorizes without a live ancestry/capability check.

## UploadBatch (`team_upload_batches`)

| Field                                            | Type          | Rules                   |
| ------------------------------------------------ | ------------- | ----------------------- |
| `id`, `team_id`, `actor_id`                      | uuid          | actor snapshot retained |
| `stage`, `offer`, `geo`, `language`, `type_hint` | text nullable | shared request          |
| `language_mode`                                  | text          | `manual                 | auto`   |
| `state`                                          | text          | `pending                | running | partial | succeeded | canceled | failed` |
| `total_items`, `succeeded_items`, `failed_items` | integer       | non-negative counters   |
| `created_at`, `updated_at`, `finished_at`        | timestamptz   |                         |

Direct client inserts/updates are revoked. Start requires `upload`; list requires `view` and
same team.

### UploadBatchItem (`team_upload_batch_items`)

Fields: `id`, `batch_id`, `team_id`, `operation_id`, `client_item_key`, `requested_name`,
`size_bytes`, `state`, `material_id`, `error_code`, progress and timestamps.

- Unique `(batch_id,client_item_key)` and one operation per item.
- Filename is visible only through the same team `view` boundary and never copied into
  analytics/contribution rows.
- Terminal item transitions update batch counters transactionally.

## MaterialEnrichment (`private.team_material_enrichments`)

Fields: `id`, `team_id`, `material_id`, `source_version`, `kind`, `decision_revision`,
`state`, `attempts`, `lease_owner`, `lease_expires_at`, `result_code`, timestamps.

Unique `(team_id,material_id,source_version,kind)`. A manual language decision increments the
material revision and cancels/fences any older automatic record. Lightweight work never
shares the heavy processing queue.

## LibraryProcessingRequirement (`team_library_requirements`)

| Field                                 | Type                    | Rules                                                    |
| ------------------------------------- | ----------------------- | -------------------------------------------------------- |
| `id`, `team_id`, `source_material_id` | uuid                    | source must be active/visible video or landing           |
| `source_version`                      | text                    | exact bytes/version identity                             |
| `kind`                                | LibraryJobKind          |                                                          |
| `variant`                             | text                    | normalized original/target-language/optimization variant |
| `state`                               | LibraryRequirementState | current need state                                       |
| `current_result_id`                   | uuid nullable           | accepted result only                                     |
| `last_error_code`                     | text nullable           | safe machine code                                        |
| timestamps                            | timestamptz             |                                                          |

Unique `(team_id,source_material_id,source_version,kind,variant)`. A later source version
marks prior pending/ready records `stale` and creates/reuses a new requirement. `ready`
requires one current accepted result.

### LibraryJobAttempt (`private.team_library_attempts`)

| Field                                         | Type                | Rules                                      |
| --------------------------------------------- | ------------------- | ------------------------------------------ |
| `id`, `requirement_id`, `team_id`, `actor_id` | uuid                | immutable binding                          |
| `agent_instance_id`                           | uuid                | opaque local installation/session identity |
| `state`                                       | LibraryAttemptState |                                            |
| `lease_token_hash`                            | bytea               | plaintext never stored                     |
| `lease_expires_at`, `last_heartbeat_at`       | timestamptz         | max two-minute claim                       |
| `progress`                                    | integer             | 0–100                                      |
| `stage`, `error_code`                         | text nullable       | allowlisted                                |
| `result_material_id`                          | uuid nullable       | candidate artifact                         |
| timestamps                                    | timestamptz         |                                            |

Only one non-expired active attempt is authoritative for a requirement. Lease claim uses a
row lock/`SKIP LOCKED`; heartbeat compares hash + actor + agent + state. Expired attempts are
marked `expired` before another claim. Attempts remain historical.

### LibraryProcessingResult (`team_library_results`)

| Field                                                   | Type               | Rules                                    |
| ------------------------------------------------------- | ------------------ | ---------------------------------------- |
| `id`, `team_id`, `requirement_id`, `source_material_id` | uuid               | exact same team                          |
| `source_version`, `kind`, `variant`                     | text               | copied immutable identity                |
| `material_id`                                           | uuid               | verified Drive artifact/catalog material |
| `state`                                                 | LibraryResultState | one current result/requirement           |
| `accepted_attempt_id`, `accepted_by`                    | uuid               | first valid result                       |
| `created_at`, `stale_at`                                | timestamptz        |                                          |

Unique current result per requirement. Acceptance locks the requirement, rechecks source
version/permission/need, then commits `current_result_id`. A later candidate becomes
`skipped` and cannot replace the accepted material.

### Transcript/translation sidecar semantics

- A transcription result is `kind='transcription', variant='original'` and its material is a
  transcript-classified text file.
- A translation is `kind='translation', variant=<BCP47 target>` and depends on the current
  original transcript/source version.
- Existing `team_material_links` records `processed_from`; the result row provides the
  stronger version/variant semantics. A new unique partial index prevents two current
  original transcript results for one `(team,source,source_version)`.
- Cached text lives only on the transcript material's existing bounded transcript fields.
  Realtime/task/list payloads expose state/id, never the body. A dedicated caller RPC returns
  text variants after `view` and exact-team checks.

## MaterialGroupIntent (`private.team_material_group_intents`)

Fields: `id`, `team_id`, `source_material_id`, `operation_id`, `action`
(`move|trash|restore`), destination, ordered member snapshot, applied member ids, compensation
state, `state` (`pending|running|reconciling|succeeded|failed`), error and timestamps.

The member snapshot contains the source plus all current sidecar material ids/Drive ids at
start. Provider mutation progress is service-only. Catalog success is published only after
all members verify. Retry uses the same idempotency operation/intent.

## TeamTask (`team_tasks`)

| Field                                      | Type          | Rules                                                                   |
| ------------------------------------------ | ------------- | ----------------------------------------------------------------------- |
| `id`, `team_id`, `created_by`              | uuid          | immutable team/creator                                                  |
| `title`                                    | text          | trimmed 1–160; default localized UI value is still persisted explicitly |
| `note`                                     | text nullable | max 2,000 chars                                                         |
| `assignee_id`                              | uuid nullable | must be active same-team member at assignment time                      |
| `assignee_label_snapshot`                  | text nullable | history after removal                                                   |
| `status`                                   | TaskStatus    |                                                                         |
| `progress_max`                             | integer       | 1–10,000, default 100                                                   |
| `progress_value`                           | integer       | 0–max, default 0                                                        |
| `progress_manually_set`                    | boolean       | monotonic false→true                                                    |
| `created_at`, `updated_at`, `completed_at` | timestamptz   |                                                                         |

Rules:

- create/update requires caller `edit`; list/get requires `view`;
- status `done` sets `completed_at`; leaving done clears it but never decreases progress;
- transition to done sets value=max only when `progress_manually_set=false`;
- any explicit progress value write permanently sets the flag true, even if unchanged;
- lowering max below value is rejected; the client must submit a valid explicit value in the
  same update or cancel;
- removed/deactivated assignee becomes null through a membership trigger while the snapshot
  remains.

## TaskAttachment (`team_task_attachments`)

| Field                                     | Type      | Rules                |
| ----------------------------------------- | --------- | -------------------- |
| `id`, `team_id`, `task_id`, `material_id` | uuid      | exact same team      |
| `position`                                | bigint    | stable display order |
| `attached_by`, `attached_at`              | uuid/time |                      |

Unique `(task_id,material_id)`. The material FK is restrictive; normal Drive trash/loss is a
tombstone, so the attachment persists. Attach RPC validates each id independently, upserts
valid rows, returns `attached`, `alreadyAttached`, and safe rejected codes. Detach deletes
only the join row and never touches Drive/catalog.

## SharePreference (`team_share_preferences`)

Fields: `team_id`, `user_id`, `allow_link_on_copy` boolean, timestamps. Primary key
`(team_id,user_id)`. Caller can read/update/delete only their row while an active team
member. It represents prompt preference, never provider permission.

## ContributionRecord (`team_contribution_records`)

| Field                       | Type                 | Rules                 |
| --------------------------- | -------------------- | --------------------- |
| `id`, `team_id`, `actor_id` | uuid                 |                       |
| `category`                  | ContributionCategory | never combined        |
| `agent_instance_id`         | uuid nullable        | only local processing |
| `action_kind`, `outcome`    | text                 | generated allowlists  |
| `occurred_at`               | timestamptz          | immutable             |

There is deliberately no JSON payload, filename, path, material content, transcript, Drive
URL/id, grant or score column. Inserts are service functions or same-transaction task/batch
actions. Owner/admin aggregate reads return counts only.

## Relationship summary

```text
teams ──< team_materials ──< team_library_requirements ──< private.team_library_attempts
  │              │                         └── team_library_results ──> team_materials
  │              ├──< private.team_material_enrichments
  │              └──< team_task_attachments >── team_tasks
  ├──< team_upload_batches ──< team_upload_batch_items
  ├──< private.team_library_folders
  ├──< private.team_material_group_intents
  ├──< team_share_preferences
  └──< team_contribution_records
```

## Caller and service function boundary

All functions are `security definer`, use `set search_path=''`, fully qualify every object,
revoke default execute and grant only the intended role.

Caller-facing (`authenticated`):

- `create_upload_batch`, `get_upload_batch`;
- `scan_library_requirements`, `list_library_requirements`, `claim_library_job`,
  `heartbeat_library_job`, `cancel_library_job` (actor derived from `auth.uid()`);
- `list_video_text_variants` (explicit body-bearing read after `view`);
- `create_team_task`, `update_team_task`, `list_team_tasks`, `get_team_task`,
  `attach_team_task_materials`, `detach_team_task_material`;
- `get_share_preference`, `set_share_preference`, `reset_share_preference`;
- aggregate contribution reads for owner/admin only.

Service-only (`service_role`):

- ensure/commit canonical folders and batch item outcomes;
- claim/commit enrichment with source-version + decision-revision fencing;
- issue/consume job grants, commit heartbeat/progress, accept/skip/fail result;
- create/read/update group intents and reconcile material groups;
- append allowlisted contribution records.

Every caller function derives actor from `auth.uid()`. No caller-supplied user/agent id is
proof. pgTAP inventories exact ACL/search-path/RLS and foreign-team/removed-member cases.

## Realtime and privacy

Realtime may publish small task rows, attachment identity markers, batch counters and safe
requirement state. It never publishes attachment filenames unnecessarily, transcript text,
provider ids/URLs, lease tokens, attempt secrets, group member snapshots or contribution
details. Clients refetch caller-checked projections after a safe team event/reconnect.
