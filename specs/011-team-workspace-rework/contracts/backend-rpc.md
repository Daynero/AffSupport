# Contract — SQL functions

All functions: `security definer`, `set search_path = ''`, fully-qualified names, `revoke all`
then `grant execute` to the named role. Rows cross to TypeScript as `unknown` and are parsed by
the guards in `packages/shared/src/team/`.

## Member reads (`authenticated`)

| Function | Input | Output | Rules |
| --- | --- | --- | --- |
| `list_team_folder_tree(p_team_id uuid)` | — | setof `TeamFolderNode` rows (all active folders) | member of team; ≤ 10,000 rows else `TREE_TOO_LARGE` (published limit) |
| `list_team_materials(p_team_id, p_parent_folder_id, p_kind text[] default null, p_after_sort_key text default null, p_after_id uuid default null, p_limit int default 100)` | keyset cursor | `FolderPage` (`rows`, `total`, `next`) | member; `p_limit ≤ 200`; `total` from indexed count; sort name asc, folders first; `kind` derived by the shared `materialKindOf(mime_type, category, kind)` rule (folder · image · video · landing · archive · transcript · document · shortcut · other), implemented once as a SQL function and once in `packages/shared` with a test proving they agree |
| `list_team_drive_selections(p_team_id)` | — | setof `TeamDriveSelection` | member |
| `get_team_storage_health(p_team_id)` | — | `StorageHealth` json | member; composes connection state, folder counts, thumbnail counts, last reconciliation — replaces the freshness probe's connection half |
| `search_materials(...)` (existing) | + `p_parent_folder_id` scope, + `p_kind` filter | existing shape + `parent_folder_id` per row (the path is built client-side from the cached tree) | unchanged permissions |

## Owner / manager writes (`authenticated`, permission-checked inside)

| Function | Input | Output | Rules |
| --- | --- | --- | --- |
| `add_team_drive_selection(p_team_id, p_drive_folder_id, p_resource_key, p_name)` | from the Picker | selection row | owner or `manage_members`; refuses duplicates and out-of-drive folders (`SELECTION_UNREACHABLE`); enqueues an index pass; audit event |
| `remove_team_drive_selection(p_team_id, p_selection_id)` | — | ok | refuses the root (`ROOT_SELECTION_REQUIRED`); tombstones descendants (`lifecycle = 'missing'`), keeps rows |
| `request_team_catalog_resync` (existing) | — | — | unchanged |

## Service (`service_role` only)

| Function | Purpose |
| --- | --- |
| `service_upsert_catalog_page` (existing) | + sets `folder_indexed_at` when `next_page_token` is null; + sets `thumbnail_state = 'pending'` for new/changed image/video/landing rows; emits `folder_indexed` event |
| `service_mark_root_state(p_connection_id, p_state, p_root_name)` | rename/move/missing handling from change replay |
| `service_claim_preview_warm(p_limit int)` | claims up to N `pending` materials in indexed folders, oldest folder first; returns rows with `drive_file_id`, `drive_version` |
| `service_commit_thumbnail(p_material_id, p_state, p_reason, p_version)` | writes the outcome; emits `thumbnail_ready` |
| `service_mint_thumbnail_session(p_team_id, p_actor_id)` / `service_verify_thumbnail_session(p_hash)` | session in `team_operations` (`kind = 'thumbnail_session'`) |
| `service_claim_landing_render(p_team_id, p_agent_fingerprint)` | one `rendering`/`stale` row for the background loop; lease 10 min |

## Error codes added to `TEAM_ERROR_CODES`

`SELECTION_UNREACHABLE`, `ROOT_SELECTION_REQUIRED`, `ROOT_MISSING`, `TREE_TOO_LARGE`,
`THUMBNAIL_SESSION_EXPIRED`, `RESTRICTED_SCOPE_NOT_APPROVED`.
