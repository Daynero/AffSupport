# Data Model — Team Workspace That Works

Additive over the existing team schema. Every new table has RLS with `revoke all` then narrow
grants; every new function is `security definer set search_path = ''`. Reverse steps go to
`supabase/migrations/ROLLBACK.md`.

## New table: `team_drive_selections`

One row per folder the owner picked. The root is always the first selection; under R1
outcome A it is the only one.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| team_id | uuid → teams | cascade |
| connection_id | uuid → team_drive_connections | cascade |
| drive_folder_id | text | provider id; unique per connection |
| resource_key | text null | |
| name | text | 1–255 |
| is_root | boolean | exactly one `true` per connection (partial unique index) |
| state | text | `active` \| `missing` \| `removed` |
| selected_by | uuid → auth.users | set null |
| selected_at | timestamptz | |
| removed_at | timestamptz null | |

RLS: members of the team may `select`; only the owner or a member with `manage_members`
(the existing permission — no new permission is introduced) may insert/update via RPC. Realtime: not published.

## Changed table: `team_drive_connections`

| Change | Notes |
| --- | --- |
| `state` check | + `root_missing` (root trashed/deleted), keeps `pending`, `connected`, `needs_reauth`, `detached` |
| `scope_set` text[] | scopes actually granted (`drive.file`, optionally `drive` after review); guards the readiness check |
| `access_expires_at` timestamptz | drives proactive refresh |
| `last_reconciled_at` timestamptz | shown on the chip; set by change replay |

## Changed table: `team_materials`

| Column | Type | Notes |
| --- | --- | --- |
| selection_id | uuid → team_drive_selections null | which picked folder this descends from (null under outcome A means the root) |
| folder_indexed_at | timestamptz null | folders only; set when the last page of children landed |
| provider_thumbnail_state | text | `pending` \| `ready` \| `unavailable` \| `not_applicable`; default by kind |
| provider_thumbnail_reason | text null | `unsupported` \| `corrupt` \| `protected` \| `too_large` \| `provider_missing` |
| provider_thumbnail_version | text null | `drive_version` the cached bytes were fetched for; mismatch ⇒ re-warm |

Indexes: `(team_id, parent_folder_id, sort_key, id)` for keyset paging;
`(team_id, provider_thumbnail_state) where provider_thumbnail_state = 'pending'` for the warm worker;
`(team_id, kind) where kind = 'folder'` for the tree read.

## Reused: `team_landing_renders`

`render_state = 'ready'` + first segment ⇒ tile. New partial index
`(team_id) where render_state in ('rendering','stale')` for the claim loop. No column changes.

## Reused: `team_operations`

Two new `kind` values: `thumbnail_session` (hashed session token, 15-min expiry, bounded
reads) and `preview_warm` (one per folder pass; `progress` = warmed / total). Existing
`state` machine (`pending → running → succeeded | canceled | failed`) applies.

## Reused: `team_catalog_events`

New `event_kind` values: `folder_indexed` (material_id = folder), `thumbnail_ready`,
`storage_state` (connection-level, material_id null). Already in realtime.

## Shared types (`packages/shared/src/team/`)

```ts
type TeamDriveSelection = { id; driveFolderId; name; isRoot; state: 'active'|'missing'|'removed' };

type TeamFolderNode = {
  id; driveFileId; parentFolderId: string | null; selectionId: string | null; name;
  indexedAt: string | null; childFolderCount; childFileCount; thumbnailReadyCount;
};

// kind = materialKindOf(mimeType, category, storedKind): shared rule, mirrored in SQL
type TeamMaterialRow = TeamMaterialSummary & {
  kind: 'folder'|'image'|'video'|'landing'|'archive'|'transcript'|'document'|'shortcut'|'other';
  parentFolderId: string | null; modifiedAt: string | null; driveVersion: string | null;
  previewState: 'pending'|'ready'|'unavailable'|'not_applicable'; previewReason?: string;
  thumbnailReady: boolean; landingRender?: { state: 'ready'|'rendering'|'stale'|'failed'|'none' };
};

type FolderPage = { rows: TeamMaterialRow[]; total: number; next: { sortKey: string; id: string } | null };

type ThumbnailSession = { token: string; expiresAt: string; teamId: string };

type StorageHealth =
  | { kind: 'connected'; lastReconciledAt: string }
  | { kind: 'indexing'; indexedFolders: number; totalFolders: number | null; files: number }
  | { kind: 'preparing'; ready: number; pending: number }
  | { kind: 'waiting_provider'; since: string }
  | { kind: 'attention'; reason: 'needs_reauth'|'root_missing'|'permission_lost'|'quota'; fixer: 'owner'|'manager' }
  | { kind: 'disconnected' };
```

## State machines

**Connection**: `pending → connected ⇄ needs_reauth`; `connected → root_missing → connected`
(restore or new root); any → `detached` (explicit). `needs_reauth` and `root_missing` keep all
rows; nothing is deleted until a replacement succeeds (FR-004).

**Folder indexing**: `unlisted (folder_indexed_at null) → listed`; change replay may reset a
folder to `unlisted` only when its `drive_version` changed and a full relist is needed.

**Thumbnail**: `pending → ready | unavailable(reason)`; `ready → pending` when
`drive_version ≠ provider_thumbnail_version` (FR-019); `not_applicable` for folders, documents,
shortcuts and archives that are not landings.

**Landing render** (existing): `rendering → ready | failed`; `ready → stale` on source change;
the claim loop takes `rendering`/`stale` rows oldest first, one at a time.

## Validation rules

- Exactly one `is_root = true` selection per connection; removing the root is refused
  (`ROOT_SELECTION_REQUIRED`).
- A selection whose folder is not under the connection's drive (my drive vs shared drive)
  is refused (`SELECTION_UNREACHABLE`).
- `provider_thumbnail_state = 'ready'` requires `provider_thumbnail_version` not null.
- `folder_indexed_at` may be set only on rows with `kind = 'folder'`.
- Thumbnail session reads: team membership active, material lifecycle `active`, session not
  expired and read count under its bound; otherwise `THUMBNAIL_SESSION_EXPIRED` /
  `PERMISSION_DENIED`, never the bytes.
