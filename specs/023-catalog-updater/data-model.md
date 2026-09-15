# 023 — Data model

Additive migrations only. Security as in 022 and constitution III: RLS enabled and forced,
`revoke all`, client access through `security definer` functions with `set search_path = ''` and
`private.can`; service functions granted to `service_role` only. Error strings are existing
`TeamErrorCode` values.

## D1 — registry, updater, ID updates

### `team_product_catalogs` (feature 022) — new columns

| Column              | Type          | Rule                                                      |
| ------------------- | ------------- | --------------------------------------------------------- |
| `update_count`      | `integer`     | not null, default 0, ≥ 0 — updates applied to this sheet  |
| `last_updated_at`   | `timestamptz` | null until the first update                               |
| `last_update_error` | `text`        | null or a `TeamErrorCode`; cleared by a successful update |

IDs after `update_count = k`: `row + 500·k + k·(k−1)/2` (research R5).

### `team_catalog_updaters` — one per space

| Column        | Type          | Rule                                             |
| ------------- | ------------- | ------------------------------------------------ |
| `team_id`     | `uuid` PK     | → `teams(id)` cascade                            |
| `state`       | `text`        | `running` \| `stopped`                           |
| `interval`    | `text`        | `1h` \| `1d` \| `1w`                             |
| `restitch`    | `boolean`     | default false; D1 refuses `true` (no device yet) |
| `device_id`   | `uuid`        | null in D1; → `team_updater_devices(id)` in D2   |
| `next_run_at` | `timestamptz` | not null while running; null when stopped        |
| `started_at`  | `timestamptz` | set on start                                     |
| `started_by`  | `uuid`        | → `auth.users`, set null                         |
| `updated_by`  | `uuid`        | → `auth.users`, set null                         |
| `updated_at`  | `timestamptz` | default now                                      |

### `team_catalog_updater_items` — catalogs in the updater

| Column                | Type          | Rule                                                            |
| --------------------- | ------------- | --------------------------------------------------------------- |
| `catalog_material_id` | `uuid` PK     | → `team_product_catalogs(material_id)` cascade                  |
| `team_id`             | `uuid`        | → `team_catalog_updaters(team_id)` cascade                      |
| `added_at`            | `timestamptz` | default now                                                     |
| `round_due_at`        | `timestamptz` | set when a round opens, cleared when this item's update commits |
| `attempts`            | `integer`     | default 0, reset on success                                     |
| `next_attempt_at`     | `timestamptz` | retry/back-off time                                             |
| `lease_owner`         | `text`        | worker id while leased                                          |
| `lease_expires_at`    | `timestamptz` | lease end                                                       |

Index `(team_id)`, partial index on `(next_attempt_at) where round_due_at is not null`.

### Functions (D1)

| Function                                                                       | Caller                     | Purpose                                                                                                                                   |
| ------------------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `list_team_product_catalogs(p_team)`                                           | `authenticated`, `view`    | registry rows (R7)                                                                                                                        |
| `get_team_catalog_updater(p_team)`                                             | `authenticated`, `view`    | updater + counts: catalogs, updated this round, failing                                                                                   |
| `save_team_catalog_updater(p_team, p_catalogs uuid[], p_interval, p_restitch)` | `authenticated`, `process` | start or change: ≥ 1 live catalog of the space, interval in the set, restitch false in D1; sets `next_run_at` on start or interval change |
| `stop_team_catalog_updater(p_team)`                                            | `authenticated`, `process` | state stopped, `next_run_at` null, items deleted                                                                                          |
| `private.invoke_catalog_updater_worker()`                                      | cron                       | R2                                                                                                                                        |
| `service_open_catalog_updater_rounds(p_worker)`                                | `service_role`             | for running updaters with `next_run_at <= now`: stamp items, advance `next_run_at`                                                        |
| `service_claim_catalog_updater_items(p_worker, p_limit, p_lease_seconds)`      | `service_role`             | R3 claim; returns item + sheet drive id/resource key + record fields + credential id                                                      |
| `service_complete_catalog_update(p_item, p_worker, p_update_count)`            | `service_role`             | lease-guarded: `update_count = p_update_count`, `last_updated_at`, clear round and error, `team_catalog_events`                           |
| `service_retry_catalog_update(p_item, p_worker, p_error, p_next_attempt_at)`   | `service_role`             | lease-guarded: attempts+1, `last_update_error`, back-off, `team_catalog_events` after 3 failures                                          |

Live catalogs only: an item whose sheet or video is no longer live is removed when claimed
(spec edge cases), with a `team_catalog_events` row.

### State

```text
stopped ──save(start)──▶ running ──save(change)──▶ running
   ▲                        │  tick: next_run_at ≤ now → open round (items.round_due_at), next_run_at += interval
   └────────stop────────────┘  item claimed → sheet rewritten → complete (update_count+1) | retry
```

## D2 — re-stitching

### `team_updater_devices`

| Column           | Type          | Rule                                                     |
| ---------------- | ------------- | -------------------------------------------------------- |
| `id`             | `uuid` PK     |                                                          |
| `team_id`        | `uuid`        | → `teams` cascade                                        |
| `actor_id`       | `uuid`        | the enrolling member; grants are minted as them          |
| `install_id`     | `text`        | agent install identity                                   |
| `label`          | `text`        | computer name shown in the dialog                        |
| `secret_hash`    | `bytea`       | SHA-256 of the device secret; the secret is never stored |
| `build`          | `text`        | app build at last contact                                |
| `tool_contracts` | `jsonb`       | contracts at last contact (FR-020 "app too old")         |
| `last_seen_at`   | `timestamptz` | heartbeat; "online" = within 2 minutes                   |
| `revoked_at`     | `timestamptz` | set on switch-off, another device chosen, member removed |
| `created_at`     | `timestamptz` |                                                          |

Private table (no client select); the dialog reads a safe projection through an RPC.

### `team_catalog_restitch_copies`

| Column                | Type          | Rule                                                      |
| --------------------- | ------------- | --------------------------------------------------------- |
| `material_id`         | `uuid` PK     | the copy's material → `team_materials` cascade            |
| `catalog_material_id` | `uuid`        | → `team_product_catalogs` cascade                         |
| `team_id`             | `uuid`        |                                                           |
| `role`                | `text`        | `spare` \| `in_use`; unique `(catalog_material_id, role)` |
| `operation_id`        | `uuid`        | the process operation that made it                        |
| `created_at`          | `timestamptz` |                                                           |

`team_product_catalogs.current_video_link text` — the `in_use` copy's shared link, or null for the
original.

### `private.catalog_restitch_jobs`

One per catalog needing a spare: `catalog_material_id` PK, `team_id`, `device_id`, `state`
(`queued|leased|cancelled`), `operation_id`, `lease_token_hash`, `lease_expires_at`, `attempts`,
`next_attempt_at`, `last_error_code`. Created on start / add / restitch-on / after a spare is consumed;
cancelled on stop / remove / restitch-off; claim scoped to the device.

### Spare lifecycle

```text
none ──job claimed, copy finalized──▶ spare(ready)
spare(ready) ──round: sheet links → spare──▶ in_use ; previous in_use → deleted permanently ; new job queued
spare(preparing|ready) ──stop / remove / restitch off──▶ job cancelled, spare deleted
```
