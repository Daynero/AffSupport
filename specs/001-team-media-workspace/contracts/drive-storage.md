# Contract: Google Drive Connection, Transfer & File Operations

Covers FR-018…FR-031. A Soty permission is necessary but not sufficient: every external
action also re-fetches current Drive ancestry and per-item capabilities. All Shared Drive
calls use `supportsAllDrives=true`; lists/changes add the corresponding all-drives flags.

## OAuth and root lifecycle

`DRIVE_OAUTH_MODE` is server-only and parsed as `disabled|testing|verified`; missing/unknown
is `disabled`. Production is true if normalized `SOTY_SITE_URL`, the request/OAuth
transaction origin, or canonical `PRODUCTION_SITE_ORIGIN` from shared release contract is
production—any signal wins.

| Mode       | Local/isolated development | Production |
| ---------- | -------------------------- | ---------- |
| `disabled` | reject                     | reject     |
| `testing`  | allow                      | reject     |
| `verified` | allow                      | allow      |

The gate runs before OAuth transaction creation, provider exchange, root replace/reauth, or
production credential refresh. Rejection makes zero OAuth/Vault/connection side effects and
returns `503 { ok:false, error:{ code:'OAUTH_APPROVAL_REQUIRED', retryable:false } }`.
Callback rejection is a fixed 303 redirect carrying only that opaque code. Existing team/
catalog state is preserved and the connection is explicitly unavailable, never deleted.

### `POST /functions/v1/drive-connect/start`

**Body**: `{ teamId, reuseCredentialId? }`.

- **Guard**: user JWT; current owner only; active profile/team.
- Reuse path requires an existing credential connected by the same owner and never exposes
  it. New path creates an expiring OAuth transaction (state hash + PKCE), then returns the
  Google authorization URL for offline `drive` access.
- Broad `drive` is a restricted scope; start applies the mode/origin gate above before it
  creates state or contacts Google.

### `GET /functions/v1/drive-oauth-callback?code&state`

- Public callback (`verify_jwt=false`); browser `Origin`/Supabase JWT is not expected.
- Atomically consumes unexpired state, exchanges code with PKCE, verifies Google principal,
  stores/updates refresh token in Vault, deletes transient verifier, and redirects 303 to a
  fixed Soty route with an opaque result code.
- A response omitting a refresh token never overwrites an existing valid one. `invalid_grant`
  transitions related connections to `needs_reauth`.
- State replay/expiry/actor-team swap changes nothing.
- A mode change between start and callback is re-evaluated; production `testing` or any
  `disabled` callback performs no exchange/storage and redirects with the opaque gate code.

### `GET /functions/v1/drive-connect/folders?teamId&parentId&pageToken?`

- **Guard**: JWT + current owner; uses the server-held credential.
- Server-proxied folder browser returns only folder id/name/drive kind and paging data; the
  broad access token never enters Google Picker/browser JS.
- My Drive and Shared Drive roots are supported; shortcut roots are rejected.

### `POST /functions/v1/drive-connect/confirm`

**Body**: `{ teamId, folderId, resourceKey?, expectedAccount }`.

- Fetches live root metadata/capabilities, confirms account, folder MIME type, not trashed,
  `canListChildren`, and drive kind. Returns a confirmation snapshot first; caller repeats
  with `confirmed: true` to persist.
- Stores root id/resource key/drive id, capability snapshot, warning about independent
  direct Drive ACLs, and enqueues initial sync. One non-detached root per team.

### `POST /functions/v1/drive-connect/replace|detach|reauth`

- **Guard**: current owner + explicit confirmation + idempotency key.
- Replace creates/validates the new connection and sync before switching active root; old
  Drive files are untouched.
- Detach revokes grants, marks detached, removes credential reference and deletes/revokes the
  Vault token only when no connection still uses it. No Drive file is deleted.
- Reauth repeats OAuth and updates Vault secret while preserving team/catalog state.

### `get_drive_connection_status(p_team) → ConnectionStatus`

- Members with `view` see root name/kind/state/sync freshness. Owner/admin additionally see
  connected account email and capabilities timestamp. Credential/Vault/cursor fields are
  absent for every client.

## Live root/capability guard

For target and destination, server resolves material id to Drive id, fetches
`id,parents,mimeType,trashed,driveId,resourceKey,shortcutDetails,capabilities`, and ascends
real parents to the exact root. Source and destination must both pass for move. Root itself
cannot be moved, renamed, or trashed. Shortcut target bytes are not read in v1. Cached
catalog parents/capabilities never satisfy this guard.

Permission → required Drive capability:

| Soty action   | Soty flag         | Current Drive check                                        |
| ------------- | ----------------- | ---------------------------------------------------------- |
| preview       | `view`            | readable blob/metadata; scoped inline representation       |
| full download | `download`        | `canDownload`                                              |
| create/upload | `upload`          | destination `canAddChildren`                               |
| rename        | `edit`            | target `canRename`                                         |
| move          | `edit`            | source/destination move capabilities                       |
| edit TXT      | `edit`            | `canModifyContent`; expected Drive version/checksum        |
| new version   | `upload`          | destination `canAddChildren`; source remains unchanged     |
| replace bytes | `upload` + `edit` | exact target content-modify capability                     |
| trash/restore | `delete`          | `canTrash` / `canUntrash`                                  |
| process       | `process`         | source readable + destination add capability at each stage |

## Catalog-backed list and metadata

Folder list/search uses Postgres catalog RPC, not live recursive Drive listing. A direct
Soty file operation writes its verified result immediately; scheduled sync reconciles
external Drive changes. Team-only GEO/language/offer/tag writes use
`update_material_metadata()` from `db-functions.md` and never invoke Drive.

## Resumable upload lifecycle

### `POST /functions/v1/drive-ops/uploads/start`

**Body**: `{ teamId, destinationFolderId, name, mimeType, sizeBytes, conflictMode,
replaceMaterialId?, versionOfMaterialId?, idempotencyKey }`.

- **Guard**: JWT + `upload`; live destination ancestry + `canAddChildren`.
- Acquires a short-lived normalized-name reservation because Drive permits duplicates.
- Existing name requires explicit `cancel | keep_both | replace`. Keep-both returns the
  reserved generated name. Replace binds one exact existing file id and additionally checks
  `edit`; it never resolves replacement “by name”.
- `versionOfMaterialId` requires the source be visible and forbids the replace branch. It
  defaults destination to the source parent unless another authorized folder is chosen,
  creates a distinct file/material, requires only `upload` for creation, and never mutates
  source bytes. Same-team/different-id/no-cycle and one immediate predecessor are enforced;
  branches from one source are allowed.
- Creates/reuses an operation, initiates a Google resumable upload with metadata/parent and
  returns `{ operationId, sessionUri, chunkMultiple: 262144, expiresAt }`.
- The session URI is a current-operation bearer capability: memory-only, redacted, never
  analytics/log/audit/browser-storage. Browser or agent sends chunks directly to Google,
  handles 308/Range and resumes. A client unable to do direct CORS may use a bounded chunk
  relay; no path buffers the whole file.

### `POST /functions/v1/drive-ops/uploads/{operationId}/finalize`

**Body**: `{ driveFileId, idempotencyKey }`.

- Re-checks actor's current permission unless the upload session is already the explicitly
  allowed in-flight operation, fetches the exact Drive result, proves destination ancestry,
  verifies name/size where available, invokes the canonical category classifier, upserts the
  material, queues version-bound transcript ingestion when applicable, creates
  `processed_from` or `version_of` plus inherited metadata when requested, appends audit,
  releases reservation, then marks succeeded.
- If Drive succeeded but finalization failed, retry is idempotent and catalog sync can
  reconcile by operation/file id. A partial upload is never a successful material.

## Metadata mutations

Metadata is not an `edit` action: only caller-checked `update_material_metadata()` with
`manage_metadata` may change GEO/language/offer/tags. Rename/move/content endpoints cannot
write those columns.

### `POST /functions/v1/drive-ops/text-edit`

**Body**: `{ teamId, materialId, text, expectedDriveVersion, expectedChecksum?,
idempotencyKey }`.

- **Guard**: JWT + `view` + `edit`; material must be an active, complete, valid UTF-8 `.txt`
  ≤1 MiB. Live root proof and Drive `canModifyContent` are required.
- Re-fetches source identity before writing. Mismatch returns `409 SOURCE_CHANGED` with no
  Drive/catalog mutation; client may reload or choose separate-version upload.
- Updates the exact Drive file, post-verifies its new identity, reclassifies, commits the
  already-validated bounded transcript text/state, appends audit, and never changes metadata.
- The existing transcription modal remains read-only; this endpoint is consumed by a new
  small team text editor and does not imply SRT/VTT/HTML/media editing.

### `POST /functions/v1/drive-ops/rename`

Body: `{ teamId, materialId, newName, conflictMode, idempotencyKey }`. Guard `edit`, live
ancestry + `canRename`, name reservation, exact post-verification, catalog/audit saga.

### `POST /functions/v1/drive-ops/move`

Body: `{ teamId, materialId, destinationFolderId, conflictMode, idempotencyKey }`. Guard
`edit`; live source + destination ancestry/capabilities; post-verify parent; preserve links.

### `POST /functions/v1/drive-ops/trash|restore`

- Trash requires `delete`, confirmation, live root proof and `canTrash`; calls
  `files.update({ trashed: true })`, never `files.delete`/`emptyTrash`.
- Restore requires `delete` + `canUntrash`, then `trashed:false`; if original parent is no
  longer allowed, owner chooses a valid root destination.
- Catalog row becomes/restores from tombstone. UI states that Google normally purges trash
  after its current retention window (30 days) and a direct Drive user can purge sooner;
  Soty never guarantees recovery.

## Download and preview transfer

### `POST /functions/v1/drive-transfer/grants`

Body: `{ teamId, materialId, purpose, operationId? }` where purpose determines `view`,
`download`, or `process`. Returns a short-lived opaque ticket/URL bound to actor, material,
purpose, max range and use count. Full browser download is refused above 100 MiB with
`AGENT_REQUIRED`; processing/large download grants are consumed by the paired agent.

### `GET /functions/v1/drive-transfer/range?grant=…`

- Validates/consumes grant, re-checks current actor membership/permission, live ancestry,
  not trashed, and `canDownload` where required.
- Accepts a single bounded `Range` (≤32 MiB), calls `files.get?alt=media`, and forwards
  200/206 with correct `Content-Length`, `Content-Range`, `Accept-Ranges`, MIME, no-store,
  and inline/attachment disposition by purpose.
- Inline media URLs use high-entropy query grants only because `<video>/<img>` cannot add an
  Authorization header; pages set `Referrer-Policy: no-referrer`. Other agent calls use a
  bearer header. Google-native exports are not served by this Range endpoint in v1.

## External failure behavior

`invalid_grant` → `needs_reauth`; root lost/trashed/inaccessible → `unavailable`; quota/429
→ retryable `RATE_LIMITED`; capability loss → `PERMISSION_DENIED` without escalation. Team,
metadata and audit remain intact. Operations end in a typed safe state, and only a verified
Drive result can become `succeeded`.
