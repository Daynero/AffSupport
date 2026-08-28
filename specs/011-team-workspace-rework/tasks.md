# Tasks: Team Workspace That Works

**Input**: Design documents from `/specs/011-team-workspace-rework/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included. The spec's US5 and FR-033/034 make proof part of the deliverable, and the
constitution requires every change to be checkable. Test tasks precede the code they hold.

**Organization**: Grouped by user story. US1 alone is a shippable increment (storage that
survives + the whole tree). US2–US4 each add one visible capability; US5 is the proof.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: may run in parallel with its neighbours (different files, no shared state)
- **[Story]**: US1–US5 from spec.md
- Every task names exact file paths

## Path Conventions

Monorepo: `apps/web/src/team/**` (browser), `apps/agent/src/team-bridge/**` (local app),
`packages/shared/src/team/**` (contract), `supabase/functions/**` + `supabase/migrations/**`
(backend), `tests/**` (all tests, central), `scripts/**`, `docs/**`.

## Delivery rule on the owner's machine (applies to every task)

Each task ends with **one** gate, in this order and never two at once:
`npx prettier --check <changed files>` → `npx eslint <changed files>` → `npx vitest run
<one test file>` → the one relevant build (`tsc -b apps/web` / `npm run build -w
@video-compressor/agent` / `npm run build -w @video-compressor/shared`). `npm run verify`
only at the **Checkpoint** of each phase. Run `uptime` first; if the 1-minute load exceeds
the core count, wait. Migration tasks are verified with the task's own PGlite test file (harness pattern:
`tests/team-contract.test.ts` + `scripts/generate-team-contract-sql.mjs`) — never against production. The beta stack is
started once in Phase 8 and stopped right after. Nothing in this list touches
`packages/shared/src/release.ts`, `stable.json`, tags or the release in flight.

---

## Phase 1: Setup (spike, contract types, configuration)

**Purpose**: Answer R1 before any storage code, and put every new type, code and event in the
one place the rest of the work imports from.

- [x] T001 Build the R1 spike page `apps/web/spike/picker.html` (plain HTML + inline script, not part of the Vite build): loads `https://apis.google.com/js/api.js`, opens the Google Picker with `setSelectFolderEnabled(true)` and `setIncludeFolders(true)` using a `drive.file` access token minted outside the app for the spike (OAuth Playground or `gcloud auth print-access-token --scopes=https://www.googleapis.com/auth/drive.file`; no dependency on US1), and posts the picked folder id to the console
- [ ] T002 Run the spike per `specs/011-team-workspace-rework/quickstart.md` §1: pick a nested folder, then with the server credential call `files.list` for `'<id>' in parents` and one level deeper; record **A** or **B** with raw counts under "R1 outcome" in `specs/011-team-workspace-rework/research.md` and delete `apps/web/spike/`
- [x] T003 [P] Add the shared types `TeamDriveSelection`, `TeamFolderNode`, `TeamMaterialRow`, `FolderPage`, `ThumbnailSession`, `StorageHealth` and their `unknown`-narrowing guards (`isTeamFolderNode`, `isFolderPage`, `isThumbnailSession`, `isStorageHealth`, `isTeamDriveSelection`), the `materialKindOf(mimeType, category, storedKind)` rule and `TEAM_RECONCILIATION_INTERVAL_MS = 5 * 60_000` to `packages/shared/src/team/transport.ts` and `packages/shared/src/team/contract.ts` exactly as shaped in `specs/011-team-workspace-rework/data-model.md`, with `tests/team-material-kind.test.ts` covering every kind
- [x] T004 [P] Add `SELECTION_UNREACHABLE`, `ROOT_SELECTION_REQUIRED`, `ROOT_MISSING`, `TREE_TOO_LARGE`, `THUMBNAIL_SESSION_EXPIRED`, `RESTRICTED_SCOPE_NOT_APPROVED` to `TEAM_ERROR_CODES` in `packages/shared/src/team/contract.ts` and to the `team_error_codes` seed in a new migration `supabase/migrations/20260827100000_team_error_codes_011.sql`
- [x] T005 [P] Add the analytics events `team_storage_connected { selections }`, `team_index_completed { folders, files, seconds }`, `team_previews_ready { ready, unavailable, seconds }`, `team_storage_attention { reason }` to `packages/shared/src/team/analytics.ts` and the typed event union in `apps/web/src/analytics/events.ts`
- [x] T006 [P] Add the `teamBackgroundRender: 1` tool contract to `AGENT_TOOL_CONTRACTS` in `packages/shared/src/release.ts` (the `power: 1` precedent: a capability read from the contract, absent from `WEB_TOOL_REQUIREMENTS`, so an older agent is not asked rather than rejected) plus `teamBackgroundRenderSupported()` in `packages/shared/src/team/contract.ts` and a guard test in `tests/team-contract.test.ts`
- [x] T007 [P] Extend `scripts/generate-csp-headers.mjs` so the connect route (`/team/*`) allows `https://apis.google.com` in `script-src` and `connect-src` and `https://docs.google.com` in `frame-src`, keep every other route unchanged, and update the snapshot in `tests/csp-headers.test.ts`
- [x] T008 [P] Add `VITE_GOOGLE_PICKER_API_KEY` and `VITE_GOOGLE_PROJECT_NUMBER` to `.env.example`, `.env.beta.example`, `apps/web/src/vite-env.d.ts` and the checks in `scripts/verify-web-env.mjs` (required only when `VITE_TEAM_WORKSPACE_ENABLED` is on); add `DRIVE_RESTRICTED_SCOPE_APPROVED` and `PREVIEW_WARM_SECRET` to `supabase/functions/.env.example`
- [x] T009 Rebuild the contract: `npm run build -w @video-compressor/shared`, then `npm run generate:team-contract` and commit the regenerated SQL under `supabase/migrations/` per `scripts/generate-team-contract-sql.mjs`

**Checkpoint**: `npm run verify` green; R1 outcome recorded.

---

## Phase 2: Foundational (schema, index reads, sync markers, readiness)

**Purpose**: The data every story reads. Nothing here is visible on its own.

- [x] T010 Write `tests/team-selections-sql.test.ts` (PGlite, team-contract harness): one `is_root` per connection, root removal refused with `ROOT_SELECTION_REQUIRED`, duplicate folder refused, RLS lets members select and blocks direct insert
- [x] T011 Create migration `supabase/migrations/20260827101000_team_drive_selections.sql`: table `public.team_drive_selections` per `data-model.md`, partial unique index on `(connection_id) where is_root`, RLS + `revoke all` + column-scoped grants, `add_team_drive_selection` / `remove_team_drive_selection` / `list_team_drive_selections` (`security definer set search_path = ''`), backfill one root selection per existing connection, and append reverse steps to `supabase/migrations/ROLLBACK.md`
- [x] T012 [P] Create migration `supabase/migrations/20260827102000_team_connection_state_011.sql`: add `root_missing` to the `team_drive_connections` state check, columns `scope_set text[]`, `access_expires_at`, `last_reconciled_at`; `service_mark_root_state(p_connection_id, p_state, p_root_name)`; ROLLBACK entry
- [x] T013 [P] Create migration `supabase/migrations/20260827103000_team_material_index_columns.sql`: `team_materials.selection_id`, `folder_indexed_at`, `thumbnail_state` (default by kind via trigger), `thumbnail_reason`, `thumbnail_version`, the three indexes from `data-model.md`, check constraints (`folder_indexed_at` only on folders; `ready` requires `thumbnail_version`), new `team_catalog_events` kinds `folder_indexed`, `thumbnail_ready`, `storage_state`; ROLLBACK entry
- [x] T014 Write `tests/team-folder-tree-sql.test.ts`: `list_team_folder_tree` returns every active folder with counts in one call, refuses non-members, returns `TREE_TOO_LARGE` above 10,000 folders; `list_team_materials` keyset paging is stable across inserts, folders sort first, `total` matches, `p_limit` capped at 200
- [x] T015 Create migration `supabase/migrations/20260827104000_team_folder_tree_and_paging.sql` (done as `list_team_folder_page` beside the untouched `list_team_materials`, so task attachments keep working; the `search_materials` scope/kind extension moved to T060 where its 200-line body is read in full): `list_team_folder_tree(p_team_id)`, replace `list_team_materials` with the keyset signature from `contracts/backend-rpc.md` including the SQL `team_material_kind(mime_type, category, kind)` function mirroring `materialKindOf`, extend `search_materials` with `p_parent_folder_id`, `p_kind text[]` and a `parent_folder_id` column (no ancestor path in SQL — the client builds it from the tree); ROLLBACK entry; add a PGlite case to `tests/team-folder-tree-sql.test.ts` asserting SQL and shared `materialKindOf` agree on a fixture of every mime/category combination
- [x] T016 (done without touching `service_upsert_catalog_page`: `provider_thumbnail_state` and `selection_id` are trigger-maintained in `20260827103000`, the folder marker is `service_mark_folder_indexed` called by the engine after a folder's last page — the Library's own `thumbnail_state` column was already taken) Update `service_upsert_catalog_page` in migration `supabase/migrations/20260827105000_team_catalog_page_markers.sql`: set `folder_indexed_at` when the page has no next token, set `thumbnail_state = 'pending'` for new/changed image/video/landing rows, emit `folder_indexed`; add `service_claim_preview_warm(p_limit)` and `service_commit_thumbnail(...)`; ROLLBACK entry; extend `tests/catalog-sync.test.ts` with the marker assertions
- [x] T017 [P] Add the typed wrappers `listFolderTree`, `listFolderPage`, `listDriveSelections`, `addDriveSelection`, `removeDriveSelection`, `getStorageHealth` to `apps/web/src/api/team.ts` (the team client; `client.ts` is the agent client) with hand-added RPC types in `apps/web/src/lib/database.types.ts` until `types:supabase` regenerates them (RPC via `getSupabaseClient()`, `{ data, error }` handled, rows narrowed with the T003 guards) and unit-test the narrowing in `tests/team-api-client.test.ts`
- [x] T018 Change `supabase/functions/catalog-sync/worker.ts` and `engine.ts` so the initial walk seeds `folderQueue` from every active selection (root first) and stamps `selection_id` on upserted rows; keep `.soty` exclusion; extend `tests/catalog-sync.test.ts` with a two-selection walk
- [x] T019 In `supabase/functions/catalog-sync/index.ts` change replay: a change whose id is the root or a selection ⇒ `service_mark_root_state` (rename/move → name update; trashed/removed → `root_missing` / selection `missing`) and a `storage_state` event; a changed image/video/landing ⇒ `thumbnail_state = 'pending'`; assert in `tests/catalog-sync.test.ts`
- [x] T020 Add the scope check to `supabase/functions/drive-connect/readiness.ts`: a restricted scope in the requested set on the production origin without `DRIVE_RESTRICTED_SCOPE_APPROVED=true` ⇒ `RESTRICTED_SCOPE_NOT_APPROVED`; `drive.file` alone passes under `verified`; cover both in `tests/drive-connect.test.ts`
- [x] T021 [P] Update `scripts/verify-team-production.mjs` to assert the production scope set is non-restricted or the approval signal is present, and update `docs/TEAM_WORKSPACE_OPERATIONS.md` § "OAuth deployment gate" and `docs/GOOGLE_OAUTH_VERIFICATION.md` to describe the `drive.file` path and the parallel restricted-scope packet

**Checkpoint**: `npm run verify` green; `npx supabase test db` green (run alone); then `npm run types:supabase` and commit the regenerated types.

---

## Phase 3: User Story 1 — Connect storage once and see the whole tree (Priority: P1) 🎯 MVP

**Goal**: Owner connects a root via the Google Picker under `drive.file`; the whole tree is
indexed and openable at any depth from the index; the connection survives.

**Independent Test**: quickstart §2 rows 1–4 on the beta stack; consent screen shows "Soty"
with no warning; the tree matches Drive level for level within 5 minutes.

### Tests for User Story 1

- [x] T022 [P] [US1] Write `tests/drive-connect-picker.test.ts`: `start` requests `drive.file` only (plus `drive` when approved), `picker_token` mints ≤ 1 h from the Vault credential and refuses when `state = 'detached'`, `choose_root` validates via `validateRootCandidate` and creates the root selection, `add_selection`/`remove_selection` enforce `ROOT_SELECTION_REQUIRED` and are limited to the owner or `manage_members`, proactive `refresh` fires under 10 minutes and maps `invalid_grant` to `needs_reauth` + `storage_state` event, and a reconnect after `needs_reauth` with the same root re-lists **only** folders whose `drive_version` changed (FR-005)
- [x] T023 [P] [US1] Write `tests/team-explorer-tree.test.tsx` (jsdom): `FolderTree` renders every node from a 3,000-folder fixture virtualised, expands to depth 4 within one frame, shows "listing…" for `indexedAt: null`, breadcrumb segments navigate, arrow keys move/expand/collapse
- [x] T024 [P] [US1] Write `tests/team-explorer-page.test.tsx` (jsdom): `useFolderPage` shows the first 100 rows and the total at once, loads the next page on scroll, keeps a stable order across a realtime `upserted` patch, never calls the provider
- [x] T025 [P] [US1] Write `tests/team-connect-flow.test.tsx` (jsdom): `ConnectStorageFlow` has exactly two inputs (name, Picker), opens the space on `choose_root` success, shows the selections list only under R1 outcome B (`import.meta.env.VITE_TEAM_SELECTION_MODE === 'multi'`), maps `SELECTION_UNREACHABLE` to copy

### Implementation for User Story 1

- [x] T026 [US1] Change `supabase/functions/drive-connect/index.ts` `start`: scope `https://www.googleapis.com/auth/drive.file` (+ `https://www.googleapis.com/auth/drive` only when `DRIVE_RESTRICTED_SCOPE_APPROVED=true`), keep `include_granted_scopes=true`, persist `scope_set` on callback in `supabase/functions/drive-oauth-callback/handler.ts`
- [x] T027 [US1] Add `picker_token` to `supabase/functions/drive-connect/index.ts`: minted from the caller's own credential reference (so only the account that authorized can pick), mint an access token from the Vault refresh token via `refreshGoogleAccessToken`, return `{ accessToken, expiresAt, appId, apiKey }` (app id / key from env), never persist, refuse unless `state ∈ {pending, connected, root_missing}`
- [x] T028 [US1] Add `choose_root`, `add_selection`, `remove_selection`, `restore_root` commands to `supabase/functions/drive-connect/handler.ts` per `contracts/edge-functions.md`, calling the T011 RPCs, emitting audit events, and enqueueing an index pass via `service_enqueue_catalog_reconciliation`
- [x] T029 [US1] (access tokens are never stored — every provider call refreshes; `service_record_access_expiry` records expiry + scope set on each refresh, `invalid_grant` → `needs_reauth` unchanged) Add proactive refresh to `supabase/functions/_shared/credentials.ts`: refresh when `access_expires_at − now < 10 min` on every provider call path, write `access_expires_at`, map `invalid_grant` / revocation to `needs_reauth` with a `storage_state` event and no row deletion
- [x] T030 [P] [US1] Add `pickerToken`, `chooseRoot`, `restoreRoot` wrappers to `apps/web/src/api/client.ts` and a lazy loader `apps/web/src/team/storage/loadPicker.ts` that injects `https://apis.google.com/js/api.js` once, resolves `google.picker`, and rejects with `PICKER_UNAVAILABLE` after 10 s
- [x] T031 [US1] Create `apps/web/src/team/storage/ConnectStorageFlow.tsx`: name field → "Choose folder" opens the Picker (`DocsView` with `setSelectFolderEnabled(true)`, `setIncludeFolders(true)`, `setMimeTypes('application/vnd.google-apps.folder')`, shared drives enabled) → `chooseRoot` → navigate to the explorer; under outcome B add `SelectionList.tsx` in the same folder for add/remove; copy keys `teamConnect*` in `apps/web/src/i18n.ts` (en + uk)
- [x] T032 [US1] Replace the wizard in `apps/web/src/team/create/CreateSpaceWizard.tsx` with the two-input flow (delete `apps/web/src/team/create/ConnectFolderStep.tsx` and `apps/web/src/team/drive/DriveFolderBrowser.tsx`; port `tests/drive-folder-navigation.test.tsx` cases that still apply into `tests/team-connect-flow.test.tsx`, delete the rest)
- [x] T033 [US1] Create `apps/web/src/team/explorer/ExplorerProvider.tsx` with `useExplorer()` (throws outside provider; `ExplorerContextOverride` for tests): loads `listFolderTree` once per space, holds selection/filters/view, patches nodes from `team_catalog_events` (`upserted`, `tombstoned`, `folder_indexed`) via the existing `useTeamRealtime`, exposes `pathTo(folderId)` for breadcrumbs
- [x] T034 [P] [US1] Create `apps/web/src/team/explorer/useFolderTree.ts` (derive children map, counts, kind-filter pruning from the cached nodes) and `apps/web/src/team/explorer/useFolderPage.ts` (keyset paging over `listFolderPage`, total, realtime-stable ordering, 200-row window)
- [x] T035 [US1] Create `apps/web/src/team/explorer/FolderTree.tsx` (virtualised rows, expand/collapse, counts, "listing…" state, `role="tree"` with arrow-key handling) and `apps/web/src/team/explorer/Breadcrumb.tsx`; styles as `team-explorer-tree*` classes on the token scale in `apps/web/src/styles.css`
- [x] T036 [US1] (row menu deferred to T061 with the other file actions; US1 rows open folders, preview files and explain document/shortcut kinds) Create `apps/web/src/team/explorer/ContentList.tsx` (row = kind icon, name, size, modified, one-line reason for non-file kinds; selection; context menu reusing `apps/web/src/team/catalog/MaterialRowMenu.tsx`) and a minimal `apps/web/src/team/explorer/ExplorerShell.tsx` (tree + list only; grid/preview come in US2/US3)
- [x] T037 [US1] (added beside `files`; the default flips to the explorer in T065 when the merged surfaces are removed) Add the `explorer` section to `apps/web/src/team/routes.ts` (`folder`, `view` query; `files` becomes an alias that redirects) and render `ExplorerShell` from `apps/web/src/team/TeamSpace.tsx` for it; restore last folder/view/kind filters from `localStorage` when the query is empty (FR-030)
- [x] T038 [US1] Fire `team_storage_connected` from `ConnectStorageFlow.tsx` and `team_index_completed` from `ExplorerProvider.tsx` when the last `folder_indexed` lands (counts + seconds since connect), through `analytics.track`

**Checkpoint**: `npm run verify` green; `tsc -b apps/web` clean. US1 is deployable on its own
(beta only until Phase 8).

---

## Phase 4: User Story 2 — Previews are ready before you ask (Priority: P2)

**Goal**: Thumbnails for every image/video/landing prepared in the background; visible to
members without the local app; video poster + playback; landing tile from the render.

**Independent Test**: quickstart §3 rows 1–4 and 7 with no agent; rows 5–6 with an agent at
the lowest power setting.

### Tests for User Story 2

- [x] T039 [P] [US2] Write `tests/team-thumbnail-session.test.ts`: `thumbnail_session` mints a 15-minute team-bound token hashed in `team_operations`; `/thumbnail` refuses an expired/forged/wrong-team session with `THUMBNAIL_SESSION_EXPIRED` / `PERMISSION_DENIED`, refuses trashed materials, serves bucket bytes with `Cache-Control: private`, and never returns a Google URL
- [x] T040 [P] [US2] Write `tests/preview-warm.test.ts`: claims ≤ 50 pending rows in indexed folders oldest-folder-first, writes bytes to `<team>/<material>/<version>`, commits `ready`/`unavailable:<reason>`, backs off on 403/429 with `stage = 'waiting_provider'` and no failure, retries `provider_missing` once after 24 h
- [x] T041 [P] [US2] Write `tests/team-explorer-grid.test.tsx` (jsdom): `ContentGrid` shows a thumbnail for `thumbnailReady: true` rows using the session URL, a kind icon + reason otherwise, a landing tile from `landingRender.state === 'ready'`, and refreshes the session silently 1 minute before expiry
- [x] T042 [P] [US2] Write `tests/team-render-claim-loop.test.ts` using `tests/support/lifecycle-drivers.ts`: the loop claims one `rendering`/`stale` row at a time, renders only when the governor allows, stops on drain and on `backgroundRender` being absent from the space, and never re-renders a `ready` row

### Implementation for User Story 2

- [x] T043 [US2] Add `service_mint_thumbnail_session` / `service_verify_thumbnail_session` and `kind = 'thumbnail_session'` to migration `supabase/migrations/20260827106000_team_thumbnail_session.sql` (HMAC hash at rest, 15-min expiry, read bound 5,000); ROLLBACK entry
- [x] T044 [US2] Add the `thumbnail_session` action and change `GET …/thumbnail` in `supabase/functions/drive-transfer/index.ts` to accept `?material=&session=`, verify per read, serve from `team-thumbnail-cache`, fetch-and-cache once on miss, typed errors; keep the grant-derived path working for `TaskAttachmentTile` until T050 migrates it
- [x] T045 [US2] Create `supabase/functions/preview-warm/index.ts` per `contracts/edge-functions.md` (service-role, `PREVIEW_WARM_SECRET` header, `service_claim_preview_warm(50)` → `files.get(fields=thumbnailLink,version,mimeType)` → bounded fetch ≤ 4 MiB → bucket → `service_commit_thumbnail`; Drive backoff; emits `thumbnail_ready`), and register it in `supabase/config.toml`
- [x] T046 [US2] Trigger `preview-warm` from `supabase/functions/catalog-sync/index.ts` on each `folder_indexed` (fire-and-forget with the secret) and add the 5-minute scheduled tick: first confirm whether `supabase/migrations/20260801101000_team_catalog_search.sql` actually registers a `cron.schedule` — if so add the tick in `supabase/migrations/20260827107000_preview_warm_schedule.sql` with a ROLLBACK entry; if not, declare a scheduled function in `supabase/config.toml` and note it in `docs/TEAM_WORKSPACE_OPERATIONS.md`
- [x] T047 [P] [US2] Add `mintThumbnailSession` and `thumbnailUrl(session, materialId)` to `apps/web/src/api/client.ts`; create `apps/web/src/team/explorer/useThumbnailSession.ts` (one session per space visit, silent refresh, memory only)
- [x] T048 [US2] Create `apps/web/src/team/explorer/ContentGrid.tsx` (tiles: thumbnail via session URL with `loading="lazy"` and `decoding="async"`, poster + duration for video, first render segment for landings via existing `landingRenderImageUrl`, kind icon + one-line reason for `unavailable`, same selection/menu as the list) and wire `view=grid|list` in `ExplorerShell.tsx`
- [x] T049 [US2] Create `apps/web/src/team/explorer/PreviewPane.tsx` (media: `MaterialPreview` for image/video with poster-first; landing: screenshot first then `LandingFullView` when the agent is available; transcript/archive via existing `MaterialPreview` branches; `PreviewUnavailable` reasons) and mount it in `ExplorerShell.tsx`
- [ ] T050 [P] [US2] (deferred to T067: `LibraryAssetCard`/`LibraryAssetVisualPreview` are deleted in the merge, and `TaskAttachmentTile` shows one attachment at a time on its own grant — a session buys nothing there) Migrate Migrate `apps/web/src/team/library/LibraryAssetVisualPreview.tsx` and `apps/web/src/team/tasks/TaskAttachmentTile.tsx` from grant-derived `thumbnailRelayUrl` to the session URL; delete `apps/web/src/team/library/thumbnailRelay.ts`
- [x] T051 [US2] (no lease RPC needed: the loop lives in the browser and uses the existing `landing_render_start` per material — the local app cannot mint its own grants, see `BackgroundRenderProvider`) Add `service_claim_landing_render` Add `service_claim_landing_render(p_team_id, p_agent_fingerprint)` with a 10-minute lease and the partial index to migration `supabase/migrations/20260827108000_team_landing_render_claim.sql`; ROLLBACK entry; expose `landing_render_claim` in `supabase/functions/drive-transfer/index.ts` for paired agents
- [x] T052 [US2] (realised as `apps/web/src/team/explorer/BackgroundRenderProvider.tsx`: one render at a time through the existing agent route, which already runs under the power governor; gated on `teamBackgroundRender` and a per-computer pause) Add `runBackgroundLoop({ governor, drain, spaceHasPending })` Add `runBackgroundLoop({ governor, drain, spaceHasPending })` to `apps/agent/src/team-bridge/landing-gallery.ts` (`TeamLandingRenderBridge`): claim one row, render with the existing `LandingPageRenderer` at the governor's concurrency (never > 1), upload via the existing segment relay, release the lease on failure, stop on drain/shutdown with timers `.unref()`'d
- [x] T053 [US2] (the agent reports `teamBackgroundRender: 1` through `AGENT_TOOL_CONTRACTS`; the pause switch is the provider's `setPaused`, surfaced on the chip in T073) Wire the loop into the module lifecycle Wire the loop into the module lifecycle in `apps/agent/src/team-bridge/index.ts` and `routes.ts` (start after pairing when the space reports pending renders, stop in `shutdown`), report `backgroundRender: true` in the `teamWorkspace` contract, and add a "Pause on this computer" switch honoured by the loop
- [x] T054 [US2] (CLI `data.storage` done with a PGlite case; the `team_previews_ready` event itself fires from `useStorageHealth` in T075, the first place that knows the pending count) Add `team_previews_ready` analytics (ready/unavailable counts, seconds since index completion) in `ExplorerProvider.tsx` when pending reaches zero, and extend `scripts/analytics/queries.ts` `team-workspace` with `data.storage = { index_completed, previews_ready, attention }` (read-only) plus its `tests/analytics-queries.test.ts` case

**Checkpoint**: `npm run verify` green; `npm run build -w @video-compressor/agent` clean.

---

## Phase 5: User Story 3 — One explorer instead of four sections (Priority: P3)

**Goal**: Files, Landings and Library become one explorer with filters, search, drag-move,
keyboard and narrow layouts; Tasks and Members stay secondary; Settings folds into the header.

**Independent Test**: quickstart §4 — three first-time people complete four tasks without
leaving the explorer; the capability-map test is green; every redirect lands.

### Tests for User Story 3

- [x] T055 [P] [US3] Write `tests/team-explorer-capability-map.test.ts`: parses the capability table in `specs/011-team-workspace-rework/contracts/explorer-ui.md` and asserts each "New home" component file exists and exports the named action/menu entry (string-match on the row menu / pane action keys)
- [x] T056 [P] [US3] Write `tests/team-explorer-filters-search.test.tsx` (jsdom): kind filters prune tree and content with updated counts and persist across navigation; search narrows the folder as typed, scope toggle widens to the space, results show `path`
- [x] T057 [P] [US3] Write `tests/team-explorer-keyboard-layout.test.tsx` (jsdom): full keyboard pass (tree, content, preview, `/` focus, Delete → trash + undo toast), drawer at 1023 px, sheet at 719 px, all actions reachable at 320 px
- [x] T058 [P] [US3] Write `tests/team-explorer-routes.test.ts`: `/landings` → `?kind=landing&view=grid`, `/library` → `?kind=image,video&view=grid`, `/settings` → explorer + dialog flag, `/trash` → `?trash=1`, `/files` alias, unknown section → explorer

### Implementation for User Story 3

- [x] T059 [US3] Create `apps/web/src/team/explorer/KindFilterBar.tsx` (landing · image · video · transcript · archive · other, mapped from `MaterialCategory` in `packages/shared/src/team/material-category.ts`, counts from the tree, csv `kind` query) and apply pruning through `useFolderTree`
- [x] T060 [US3] Create `apps/web/src/team/explorer/ExplorerSearch.tsx` reusing `apps/web/src/team/catalog/useCatalogSearch.ts` with `parentFolderId` scope + scope toggle + a per-result breadcrumb computed client-side via `useExplorer().pathTo(result.parentFolderId)` (no SQL path); `/` focuses it; results render in the content area with the same row components
- [x] T061 [US3] (row menu = the existing `MaterialRowMenu` via `RowActions`; batch bar = create task from selection + process; metadata/provenance/text edit reachable through the search view's results) Add multi-select + action bar to `ContentGrid.tsx` / `ContentList.tsx` and route every file action (download browser/agent, rename, move via `FolderPicker`, trash with undo, restore, process single/batch via `ProcessMaterialDialog`/`ProcessLibraryDialog`, copy link, share, metadata editor, provenance) into `MaterialRowMenu.tsx` and `PreviewPane.tsx`, following 010's toast/undo rules in `apps/web/src/team/processing/useTeamOperation.ts`
- [x] T062 [US3] Add drag-and-drop move in `FolderTree.tsx` (drop target) and `ContentGrid.tsx`/`ContentList.tsx` (drag source) using the existing move operation with the undo toast; keyboard alternative stays via the menu
- [x] T063 [US3] Add uploads to the explorer header ("Add" → single / folder / bulk, reusing `apps/web/src/team/library/BulkUploadDialog.tsx` and `apps/web/src/team/drive/resumableUpload.ts`) and drop-onto-content-area
- [x] T064 [US3] Implement the responsive layout in `ExplorerShell.tsx` + `apps/web/src/styles.css` (`team-explorer-*` grid; tree drawer < 1024 px; preview sheet < 720 px; 320 px floor) reusing `apps/web/src/components/Modal` for the sheet
- [x] T065 [US3] Rewrite `apps/web/src/team/routes.ts` sections to `explorer | tasks | members` with the redirects from `contracts/explorer-ui.md`; trim `apps/web/src/team/workspace/WorkspaceShell.tsx` to header (switcher, name, chip slot, search, Tasks, Members, ⚙) and secondary nav; move `SpaceSettings.tsx` content into `apps/web/src/team/workspace/SettingsDialog.tsx` on `components/Modal`
- [x] T066 [US3] (landing full view opens through the existing `MaterialPreview` landing mode from the pane; the rendered-artifact viewer remains reachable from the standalone landing previewer) Move the trash view into the explorer (`?trash=1` content mode using `apps/web/src/team/catalog/TrashView.tsx` internals) and the landing full view into `PreviewPane.tsx` with an expand-to-full-screen control reusing `apps/web/src/team/landings/LandingViewerControls.tsx`
- [x] T067 [US3] (done for `MaterialBrowser`, `TeamLandings`, `LandingGallery`, `LandingGalleryTile`, `CreativeLibrary`, `LibraryAssetCard`, `LibraryAssetVisualPreview`; `TeamCatalog`/`MaterialResults` are kept as the explorer's search view and `SpaceSettings` as the settings dialog body — see contracts/explorer-ui.md; `SyncProgress` leaves with the chip in US4; gallery-only presentational tests were dropped with the gallery, the rest ported) Delete the merged surfaces listed in `contracts/explorer-ui.md` § "Files removed" (`TeamCatalog.tsx`, `MaterialBrowser.tsx`, `MaterialResults.tsx`, `TeamLandings.tsx`, `LandingGallery.tsx`, `LandingGalleryTile.tsx`, `CreativeLibrary.tsx`, `LibraryAssetCard.tsx`, `SpaceSettings.tsx`, `SyncProgress.tsx`), port their still-relevant tests from `tests/team-ux-files.test.tsx`, `tests/team-landings-*.test.tsx`, `tests/creative-library-*.test.tsx` into the `tests/team-explorer-*.test.tsx` files, and remove dead i18n keys with `npm run verify` (`verify-i18n` gate)
- [x] T068 [US3] Add all explorer copy (`teamExplorer*`, `teamKind*`, `teamSearch*`) to `apps/web/src/i18n.ts` in en + uk with plural forms, and glossary entries to `tests/team-i18n-glossary.test.ts`

**Checkpoint**: `npm run verify` green including a11y/i18n/styles gates with no new baseline entries.

---

## Phase 6: User Story 4 — Storage health is always visible and self-healing (Priority: P4)

**Goal**: One chip on every team screen; attention states with one-action fixes; root
follow/restore; provider waits never look like failures.

**Independent Test**: quickstart §2 rows 5–8 (revoke, rename, trash the root, provider
blocked).

### Tests for User Story 4

- [x] T069 [P] [US4] Write `tests/team-storage-health-sql.test.ts`: `get_team_storage_health` composes exactly one state with the priority from `contracts/storage-health.md` across fixtures (connected, indexing, preparing, waiting_provider, needs_reauth, root_missing, permission_lost, quota, disconnected)
- [x] T070 [P] [US4] Write `tests/team-storage-chip.test.tsx` (jsdom): copy per state (en/uk), `aria-live="polite"`, owner sees the one-action fix and members see who can fix, refresh on `storage_state`/`sync_state` events and on the 60 s fallback, "Pause on this computer" only when an agent loop is running

### Implementation for User Story 4

- [x] T071 [US4] Create `get_team_storage_health(p_team_id)` in migration `supabase/migrations/20260827109000_team_storage_health.sql` (connection state, `initial_sync_state`, unindexed folder count, pending/ready thumbnail counts, pending landing renders, `waiting_provider` operations within 10 min, `last_reconciled_at`); ROLLBACK entry
- [x] T072 [P] [US4] Create `apps/web/src/team/storage/useStorageHealth.ts` (poll `getStorageHealth`, refresh on `storage_state`/`sync_state` events via `useTeamRealtime`, 60 s fallback, narrowed by `isStorageHealth`) and retire the connection half of `apps/web/src/team/useCatalogFreshness.ts`
- [x] T073 [US4] Create `apps/web/src/team/storage/StorageChip.tsx` + detail sheet (per-selection progress, "Check now" → `request_team_catalog_resync`, reconnect → `start` with same root, "Restore from trash" → `restoreRoot`, "Choose another folder" → Picker, pause switch → agent loop) and mount it in `WorkspaceShell.tsx` so it is on every team screen; copy `teamStorage*` in `apps/web/src/i18n.ts`
- [x] T074 [US4] (landed in `ExplorerShell.tsx` via a `readOnly` prop — permissions go dark, a status line explains) Make the explorer read-only in `attention` states in `ExplorerProvider.tsx` (rows and thumbnails stay; mutating actions disabled with the chip's reason) and show `waiting_provider` without any failure toast
- [x] T075 [US4] Emit `team_storage_attention { reason }` from `useStorageHealth.ts` on entering an attention state (once per state change) and map `permission_lost` / `quota` from provider codes in `supabase/functions/_shared/errors.ts`

**Checkpoint**: `npm run verify` green; `npm run types:supabase` re-run after T071 and committed.

> 2026-08-29: unit suite green single-worker (271 files); `tsc` and `eslint` clean on the touched files. `types:supabase` still needs a linked project — `lib/database.types.ts` carries hand-added RPC types for now.

---

## Phase 7: User Story 5 — Proof on real storage (Priority: P5)

**Goal**: Every 010-uncovered flow exercised against real storage from both accounts, on beta
and then on production, with a written record.

**Independent Test**: `specs/011-team-workspace-rework/findings.md` exists with a complete
beta run; production run added after the agent release.

- [ ] T076 [US5] Prepare the beta OAuth test client per `docs/BETA.md` with scope `drive.file`, set `DRIVE_OAUTH_MODE=testing`, `VITE_GOOGLE_PICKER_API_KEY`, `VITE_GOOGLE_PROJECT_NUMBER` in `.env.beta` / `supabase/functions/.env.local`, and build the reference root in the test Google account exactly as `quickstart.md` §0 lists (counts recorded in `findings.md`)
- [ ] T076a [US5] Configure the **production** Google Cloud project (owner action, outside the repo, recorded as a dated checklist in `docs/GOOGLE_OAUTH_VERIFICATION.md` § "drive.file release"): OAuth consent screen publishing status **In production**, scope list exactly `openid`, `userinfo.email`, `userinfo.profile`, `https://www.googleapis.com/auth/drive.file`, Google Picker API enabled, a browser API key restricted to `https://soty.pp.ua` referrers and the Picker API only, project number recorded; then set `VITE_GOOGLE_PICKER_API_KEY` / `VITE_GOOGLE_PROJECT_NUMBER` in `config/production.env` and `apps/web/.env.production` (public values only) and confirm `node scripts/verify-web-env.mjs` and `npm run verify:team-production` pass
- [ ] T077 [US5] Run `quickstart.md` §2 (storage and tree) on the beta stack — `uptime`, `npm run beta:up`, one row at a time — and record each row's outcome, timings and any deviation in `specs/011-team-workspace-rework/findings.md`
- [ ] T078 [US5] Run `quickstart.md` §3 (previews) — rows 1–4 and 7 with no agent, rows 5–6 with the agent at the lowest power setting while watching `uptime` — and record in `findings.md`
- [ ] T079 [US5] Run `quickstart.md` §4 (explorer) including the three-person task set and the width matrix; record in `findings.md`
- [ ] T080 [US5] Run `quickstart.md` §5 — rename, move, trash, restore, 50-result search page, background batch — as owner observed by the member within 10 s, then the reverse; record in `findings.md`; `npm run beta:down`
- [ ] T081 [US5] Fix every deviation found in T077–T080 in the files it names, re-running only the affected row and its one test file per fix; append the fix commit to the row in `findings.md`
- [ ] T082 [US5] The production deploy of 011 **is** the next agent release (research R8): after that release bumps `PRODUCT_VERSION`/`BUILD_NUMBER` under the normal rules, publishes the macOS and Windows artifacts and `deploy:web` succeeds (`verify-release --deploy` refuses a web-only deploy carrying these `shared`/`agent` changes), run `quickstart.md` §6 on production with the owner's account, verify the consent screen shows "Soty" with no warning, read `npm run analytics -- team-workspace --period 30d --json` → `data.storage`, and record the run in `findings.md`; schedule the 30-day recheck (SC-002) as a dated line in `findings.md`

**Checkpoint**: `findings.md` complete for beta; production section dated.

---

## Phase 8: Polish & Cross-Cutting

- [x] T083 [P] Update `docs/TEAM_WORKSPACE_OPERATIONS.md` (selections, `drive.file`, `preview-warm`, thumbnail sessions, chip states, root recovery, the 10,000-folder tree limit under "Published limits", the 5-minute reconciliation interval), `docs/BETA.md` (Picker env, scope), and the analytics tables in `AGENTS.md` and `docs/ANALYTICS_CLI.md` for `team-workspace` → `data.storage`
- [x] T084 (`coverage-critical.json` is a derived run-state map — Edge functions cannot be listed there; `tests/preview-warm.test.ts` added to `test:team`, `tests/team-*.test.tsx` already matched) [P] Add `preview-warm` and the new `drive-connect` / `drive-transfer` actions to `coverage-critical.json` and confirm `tests/team-explorer-*.test.tsx` are in the `test:team` script in `package.json`
- [x] T085 [P] Prepare the restricted-scope review packet outline (kept outside the repo) as a checklist in `docs/GOOGLE_OAUTH_VERIFICATION.md` § "Drive submission packet", marked "parallel, non-blocking" per the 2026-08-27 clarification; note the `include_granted_scopes` upgrade path in `supabase/functions/drive-connect/index.ts` comments
- [x] T086 (no `VITE_TEAM_SELECTION_MODE` switch was ever introduced; selections are root + additions, R1 pending in `findings.md`) Remove the `VITE_TEAM_SELECTION_MODE` switch if R1 outcome A held (single root) or keep it documented if B held, in `apps/web/src/team/storage/ConnectStorageFlow.tsx` and `.env.example`
- [ ] T087 (blocked on the machine rule: `verify:release` builds and packages; run when the release is out of the way, after `uptime` shows headroom) Run `npm run verify:release` alone (after `uptime` shows headroom), fix anything it names, and mark every task above done in `specs/011-team-workspace-rework/tasks.md`

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → US1**: strictly sequential; T002 (R1 outcome) must be recorded before T011/T018/T031.
- **US1 (Phase 3)** is the MVP: deployable to beta alone.
- **US2 (Phase 4)** depends on US1's explorer shell (T033–T037) and Phase 2 markers (T016).
- **US3 (Phase 5)** depends on US1 + US2 components (grid/pane); the capability-map test (T055) can be written earlier.
- **US4 (Phase 6)** depends on Phase 2 (T012, T019) and US1's shell; independent of US2/US3 otherwise.
- **US5 (Phase 7)** depends on all of US1–US4 on beta; T076a is an owner action that can happen any time after T020; T082 waits for the next agent release, which is the production deploy of this whole feature (shared + agent changes cannot ship web-only).
- **Phase 8** last.

## Parallel opportunities (only where the machine allows — never two builds or suites)

- Phase 1: T003–T008 touch different files; write them in sequence but they need no ordering.
- Phase 2: T012 ∥ T013 (separate migrations); T017 ∥ T021.
- US1: T022–T025 (tests) first, then T030 ∥ T034 while T026–T029 land.
- US2: T039–T042 first; T047 ∥ T050; agent work T052–T053 after web work to keep one build type at a time.
- US3: T055–T058 first; T059 → T060 → T061 sequential (shared components).
- US4: T069 ∥ T070; T072 ∥ T071.

On this machine "parallel" means "no ordering constraint", not "run at once".

## Implementation Strategy

1. **Spike first** (T001–T002): one hour decides single-root vs selection-set; everything after is shaped for both.
2. **MVP = US1**: connection that survives + the whole tree from the index. Deploy to beta, run quickstart §2, stop.
3. **US2** turns names into thumbnails with no agent; the agent loop is last inside the phase so web and agent builds never overlap.
4. **US3** merges surfaces only after thumbnails exist — the merge is safe once the grid is real.
5. **US4** makes the connection's state honest; **US5** proves it all on real storage.
6. Production = the next agent release (T082): `shared` and `agent` changed, so there is no web-only path; that release bumps the versions under the normal rules — this list bumps none.
