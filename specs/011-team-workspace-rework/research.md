# Research — Team Workspace That Works

Date: 2026-08-27. Sources are the codebase, its records, production analytics (read-only CLI),
and two web checks of Google's OAuth policy. Each item ends in a decision the plan relies on.

## R1 — Does a folder picked in the Google Picker under `drive.file` carry its descendants?

**Finding**: Not settled by documentation. Google's scope guide recommends `drive.file` +
Picker for explicit selection and lists `drive` as restricted; community answers disagree on
whether a picked _folder_ grants its children. Nothing authoritative was found either way.

**Decision**: A one-hour spike, run before any storage code is written (task order: first in
Phase 2). Throwaway page: Picker with `setSelectFolderEnabled(true)` + `drive.file`, pick a
folder with nested content, then `files.list` with `'<picked-id>' in parents` and one level
deeper using the server credential. Record the result in this file under "R1 outcome".

- **Outcome A (descendants reachable)**: one root, tree walk as today.
- **Outcome B (only the picked items)**: the space holds a **selection set** — the owner
  picks one or more folders (the Picker allows multi-select); `catalog-sync` walks each
  selection as its own root; the explorer shows selections as top-level nodes. Per the
  2026-08-27 clarification the release ships on B if A fails, and the restricted-scope review
  is submitted in parallel; on approval the `drive` scope is added with
  `include_granted_scopes` and the walk reaches the original root without re-selection.

Both outcomes share the same data model (`team_drive_selections` with the root as the first
selection), so the spike changes behaviour, not structure.

**Alternatives rejected**: `drive.readonly` / `drive.metadata.readonly` — also restricted;
Drive for Desktop + local folder — a different product (files on one member's disk).

## R2 — Why the production connection dies

**Finding**: `supabase/functions/drive-connect/index.ts:161` requests
`https://www.googleapis.com/auth/drive` (restricted). `docs/GOOGLE_OAUTH_VERIFICATION.md`
records that the restricted-scope review was never submitted and the app must not claim Drive
is live. `config/production.env` nonetheless sets `DRIVE_OAUTH_MODE=verified`, so the code
path opens while the OAuth app is in Google's _Testing_ status. Google's policy (confirmed
2026-08-27): Testing status → refresh tokens expire after 7 days (`invalid_grant`), only listed
test users may consent, and the consent screen warns. Switching the app to _In production_
without verification keeps the warning, imposes a lifetime 100-user cap, and per Google's
"Unverified apps" page the refresh-token lifetime remains limited for restricted scopes.

**Decision**: Move to `drive.file` (non-restricted): no warning, no cap, no weekly expiry,
no review. Keep `DRIVE_OAUTH_MODE` semantics; `verified` now means "the requested scope set is
non-restricted or reviewed", enforced by a new check in `readiness.ts` that refuses a
restricted scope on the production origin unless a `DRIVE_RESTRICTED_SCOPE_APPROVED=true`
signal is present. Add proactive refresh (refresh when < 10 min remain, not on failure) and
map `invalid_grant`/revocation to `needs_reauth` (already typed) with a one-action reconnect
that reuses the existing `reconnect_same_drive_root` migration path.

**Immediate owner action (no code)**: none needed once `drive.file` ships; until then the
owner should not expect a Testing-status connection to last a week.

## R3 — Full tree from the index

**Finding**: `team_materials` stores `parent_folder_id` and `kind`; folders are rows. The
catalog reads (`list_team_materials`) return one parent's children with no paging cursor and
no total; `MaterialBrowser` cannot rebuild a breadcrumb. At the 50,000-material limit a space
has on the order of 2,000–6,000 folders — small enough to return in one read.

**Decision**: `list_team_folder_tree(team_id)` returns every active folder row
(`id, drive_file_id, parent_folder_id, name, selection_id, indexed_at, child_folder_count,
child_file_count, thumbnail_ready_count`) in one call, cached in the `ExplorerProvider` and
patched by `team_catalog_events` realtime. Breadcrumbs, counts and kind-filter pruning are
computed client-side; search results show their path the same way (`pathTo(parentFolderId)`
from the cached tree), so `search_materials` returns no ancestor column and the 50k benchmark
is unaffected. `list_team_materials` gains keyset paging
(`after: {sortKey, id}`, `limit ≤ 200`) and a `total` computed once per folder from an
indexed count. **Rejected**: recursive CTE per click (provider-free but a query per
expansion, and breadcrumbs still need ancestors); materialised path column (a migration over
existing rows and a trigger for every move — more than the tree read costs).

## R4 — "Openable as soon as indexed"

**Finding**: `catalog-sync/worker.ts` walks a `folderQueue` breadth-first, upserting a page
at a time with checkpoints, then replays changes. There is no per-folder "fully listed"
marker, so the UI cannot tell an empty folder from an unlisted one.

**Decision**: Add `team_materials.folder_indexed_at` set by `service_upsert_catalog_page`
when a folder's last page lands; the tree read exposes it; the explorer shows a folder as
"listing…" until it is set. Re-indexing on reconnect only touches folders whose
`drive_version` differs (change replay already provides this).

## R5 — Thumbnails without the local app

**Finding**: Drive returns `thumbnailLink` for images and videos; `drive-transfer` already
relays it (`/thumbnail`) and caches bytes in the private `team-thumbnail-cache` bucket keyed
by version+checksum; only `LibraryAssetVisualPreview` and `TaskAttachmentTile` use it, via a
URL derived from a per-material range grant. `team_materials.preview_state` exists but is not
surfaced in `TeamMaterialSummary`. Landing renders (`team_landing_renders`) are WebP segments
in `.soty/landing-previews/…`, rendered on demand by a paired agent.

**Decision**:

- **Thumbnail session**: `drive-transfer` action `thumbnail_session` mints a 15-minute,
  team-bound, purpose `thumbnail` token (HMAC over team, member, expiry; hashed at rest in
  `team_operations` like grants). `/thumbnail?material=<id>&session=<token>` authorises
  membership + lifecycle on every read and serves from the bucket. One session per explorer
  visit, refreshed silently.
- **Warm worker** (`preview-warm` Edge Function): claims folders whose `folder_indexed_at` is
  set and `thumbnail_state = 'pending'` rows exist, fetches `thumbnailLink` for up to 50
  materials per invocation into the bucket, sets `thumbnail_state` (`ready` /
  `unavailable:<reason>`), bounded by Drive quota with backoff. Triggered by `catalog-sync`
  on folder completion and by a scheduled tick. The tick reuses the scheduler the catalog
  already uses if `20260801101000_team_catalog_search.sql` really registers a `cron.schedule`
  (to be confirmed in T046 before writing the migration); otherwise it is a Supabase
  scheduled function declared in `supabase/config.toml`.
- **Landing tiles**: the first WebP segment of a ready render is the tile; a background claim
  loop in the agent (`TeamLandingRenderBridge`) renders pending landings one at a time under
  the power governor when the space has any; without an agent the tile shows the kind icon
  and the one-line "open the local app to render" reason.
- **Video**: poster = Drive thumbnail; playback = existing range relay.
  **Rejected**: agent-generated thumbnails for images/videos (needs a paired agent, duplicates
  what Drive already produces); public bucket (violates least privilege).

## R6 — One explorer

**Finding**: `routes.ts` sections `files | tasks | landings | settings` plus Library reached
from the shell; `WorkspaceShell` renders tabs; `TeamCatalog`, `TeamLandings`, `CreativeLibrary`
are three browsers over `team_materials`. Feature 010 already made file actions row-local,
added a toast provider, a folder picker and a trash view — all reusable.

**Decision**: New `team/explorer/` with a three-pane layout (tree / content / preview), kind
filters (`landing | image | video | transcript | archive | other`) mapped from the existing
`MaterialCategory`, search reusing `useCatalogSearch` with a scope toggle, and a preview pane
wrapping `MaterialPreview`, `LandingFullView` and the library share/process actions.
Sections become `explorer | tasks | members`; `landings` → `explorer?kind=landing`,
`library` → `explorer?kind=image,video&view=grid`; Settings becomes a header dialog. The
capability map in `contracts/explorer-ui.md` is enforced by a test so nothing is dropped.
**Rejected**: keeping tabs and only adding thumbnails (leaves three code paths to keep right).

## R7 — Storage chip sources

**Finding**: `team_drive_connections.state`, `initial_sync_state`, `last_error_code`,
`last_synced_at` exist; `useCatalogFreshness` polls freshness; `team_catalog_events`
`sync_state` events are in realtime; `team_drive_connections` is deliberately not in realtime.

**Decision**: `useStorageHealth` composes one `StorageHealth` value (see
`contracts/storage-health.md`) from the freshness probe (extended with connection state,
indexed/total folder counts, thumbnail ready/pending counts, last reconciliation) refreshed
on `sync_state` events and on a 60 s fallback. No new realtime tables. The reconciliation
interval (change replay + `preview-warm` tick) is **five minutes**, one constant in
`packages/shared/src/team/contract.ts` (`TEAM_RECONCILIATION_INTERVAL_MS`), shown on the chip.

## R8 — Agent change and the release in flight

**Finding**: The render claim loop lives in the agent; a web-only deploy must not carry
unreleased agent changes; a release is in progress now.

**Decision**: This feature changes `packages/shared` (new types, codes, events, the
`backgroundRender` capability) and `apps/agent` (the render claim loop). Under the release
rules a web-only deploy must not carry unreleased `shared`/`agent` changes, and
`verify-release --deploy` enforces that regardless of any runtime gating. Therefore **the
production deploy of 011 is the next agent release**: `PRODUCT_VERSION`/`BUILD_NUMBER` are
bumped by that release under the normal procedure (not by this plan), the DMG/Windows
artifacts ship first, and `deploy:web` follows. Until then everything is verified on the beta
stack and `package:dev:dmg`. The `backgroundRender: true` capability still gates the loop so a
member on an older agent is simply not asked and sees the explanation on the tile.

## R9 — Root rename / move / delete

**Finding**: change replay (`change_page_token`) delivers root changes but the worker only
handles children; a trashed root yields `ROOT_ESCAPE` on the next proof.

**Decision**: in `catalog-sync`, a change for the root id updates `root_folder_name` (rename /
move) or sets connection `state = 'root_missing'` (trashed / deleted); `drive-connect` gains
`restore_root` (untrash via provider) and `choose_new_root` (Picker again). The chip maps
`root_missing` to "needs attention — the folder was deleted".

## R10 — Analytics

**Finding**: `team-workspace` CLI reads SC-001/SC-005/SC-009 from `team_onboarding_*`,
`team_find_*`, `team_workflow_*`; no event marks indexing or preview completion.

**Decision**: add `team_storage_connected`, `team_index_completed` (with folder/file counts),
`team_previews_ready` (ready/unavailable counts), `team_storage_attention` (reason) to
`packages/shared/src/team/analytics.ts` and to `scripts/analytics/queries.ts`
(`team-workspace` → `data.storage`), read-only as always.

## R1 outcome

**B — only the picked items.** Settled 2026-08-29 on the beta stack against the real
account, not with the throwaway page (the connected space already had a server credential):
the stored `drive.file` refresh token was exchanged and `files.list` with `'<id>' in parents`
was run for two roots picked in the Picker.

| Root picked in the Picker                             | `files.get` | children under `drive.file` |
| ----------------------------------------------------- | ----------- | --------------------------- |
| `Mock` — every file inside was uploaded through Soty  | ok          | **21**                      |
| `Soty` — the owner's own folder, files added in Drive | ok          | **0**                       |

`capabilities.canListChildren` is `true` for both; the listing is simply empty for content
the app did not create. So a picked _folder_ does not carry its descendants: the space sees
what Soty uploaded and what was picked file by file, and the initial scan of a real folder
finishes with nothing (findings I2). The release ships on B as decided on 2026-08-27; the
restricted `drive` scope, once approved, is added with `include_granted_scopes` and the
walk reaches the original root without re-selection. For the beta project (publishing
status Testing) the restricted scope can be turned on now with
`DRIVE_RESTRICTED_SCOPE_APPROVED=true` — test users can consent to it without verification.
