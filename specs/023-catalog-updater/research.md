# 023 — Research (Phase 0)

Checked against the code on 2026-09-15 (branch `023-catalog-updater` = released 1.1.1 + feature 022).
Pre-spec facts are in [`findings.md`](findings.md).

## R1. Two deliveries

- **Decision**: **D1** — registry, updater, panel, ID updates — ships as backend + web, keeping
  `packages/shared/src`, `apps/agent`, `packaging` untouched so `deploy:web` accepts it (the 022 rule).
  **D2** — automatic re-stitching — ships with a desktop release.
- **Rationale**: Re-stitching needs FFmpeg and the member's local screen images on a paired agent, and
  the agent never takes work from the server today (no Supabase session, no polling loop). Nothing in
  D1 needs the agent.

## R2. The scheduled worker (D1)

- **Decision**: New Edge Function `catalog-updater` (`verify_jwt = false`), authenticated with the
  existing `requireNamedWorkerSecret(request)` defaults (`CATALOG_SYNC_SECRET`,
  `x-catalog-sync-secret`, `supabase/functions/_shared/auth.ts`). A migration adds
  `private.invoke_catalog_updater_worker()` copying `20260907140000_catalog_progress_keeps_its_lease.sql`:
  early exit when nothing is due or three leases are live, read `wishly_catalog_sync_secret`, derive the
  URL from `wishly_catalog_sync_url` by replacing the trailing `/catalog-sync` with `/catalog-updater`,
  `net.http_post`. `cron.schedule('wishly-catalog-updater', '1 minute', …)` after unscheduling.
- **Rationale**: A new secret means `supabase secrets set` + two Vault rows by hand in production
  (`docs/SUPABASE_SETUP.md` §9, `scripts/lib/beta-worker-secrets.mjs` header) — a manual step the owner
  cannot automate from here. Function secrets are project-wide, so reusing the catalog-sync secret and
  deriving the URL needs no manual step in beta or production.
- **Alternatives**: A route inside `catalog-sync` — rejected: its handler always claims sync jobs and
  the invoker only fires when sync jobs are due. A route inside `drive-ops` — rejected: user-JWT
  routes, easy to misroute. A new secret — rejected (manual production step).

## R3. Due work and leases (D1)

- **Decision**: The updater row holds one `next_run_at`. When a tick finds it due, one SQL call
  **opens a round**: stamps `round_due_at` on every item of that updater and sets
  `next_run_at = now() + interval` — so an overdue updater runs one round, not one per missed interval
  (FR-009). Items with a `round_due_at` are claimed with the catalog-sync lease pattern: advisory lock,
  global slot cap, `for update skip locked`, lease 60 s, `next_attempt_at` pushed to lease end,
  lease-guarded `complete` / `retry` returning `found`.
- **Rationale**: One due time per space is what the panel counts down; per-item leases keep one failing
  sheet from blocking others (FR-010). Pattern proven in `private.claim_catalog_sync_jobs`.
- **Budget**: ~8 s per invocation (catalog-sync uses 8 s; the local runtime has ended isolates near
  19 s), up to 10 items per claim, one Drive client per credential (preview-warm `driveFor` pattern),
  `NEEDS_REAUTH` → `service_mark_drive_needs_reauth`.

## R4. Rewriting a sheet in place (D1)

- **Decision**: New `GoogleDriveClient.updateConvertedFile({ fileId, resourceKey, sourceMimeType,
targetMimeType, bytes })` — multipart `PATCH upload/drive/v3/files/{id}?uploadType=multipart` with
  metadata `{ mimeType: targetMimeType }` and the XLSX body, 60 s timeout, 10 MB cap, returned
  `mimeType` and `id` must equal the target and the original id. Rows are rebuilt with 022's
  `buildProductCatalogRows` + `buildXlsx` from `team_product_catalogs` (`settings_snapshot`,
  `source_link`, `video_link`, `product_count`) with IDs shifted (R5) and, in D2, a replaced video link.
- **Verification debt**: that a multipart PATCH with conversion keeps a native Sheet with the same id
  and link is standard Drive behaviour but must be proven on real Drive first (quickstart §3). Fallback:
  Sheets API `values.update` with `RAW` — needs the Sheets API enabled in the Google project.
- **Alternatives**: `updateSmallFileContent` — 1 MB, 15 s, no conversion target. New sheet + trash old
  — rejected: the link changes (spec: the sheet keeps its link).

## R5. The ID rule

- **Decision**: After _k_ updates, every row's ID is `row + offset(k)` with
  `offset(k) = 500·k + k·(k−1)/2` — the owner's +500, +501, +502… as a closed form. The catalog stores
  `update_count`; the worker computes IDs from row number and the new count, never from the sheet's
  current cells (hand edits are overwritten, spec edge case).
- **Rationale**: Deterministic from stored state, idempotent on retry (a retried update writes the same
  IDs), no repeats (each step ≥ 500 > 400 rows; checked for 2000 updates).
- **Numbers**: at one update per hour for ten years (k ≈ 87 600) the offset is about 3.9·10⁹ — past a
  32-bit integer, so the offset is computed as `bigint` in SQL and as a JS number (safe to 2⁵³) in the
  worker; `update_count` itself stays an `integer`. IDs remain numeric cells.

## R6. Where catalog state lives (D1)

- **Decision**: Extend `team_product_catalogs` (additive): `update_count integer not null default 0`,
  `last_updated_at timestamptz`, `last_update_error text`, and (D2) `current_video_link text` — the
  link the sheet currently uses when it is a re-stitched copy. The updater is `team_catalog_updaters`
  (one per space) + `team_catalog_updater_items` (catalogs in it, round/lease state).
- **Rationale**: `update_count` must survive leaving and rejoining the updater, or IDs could repeat;
  it belongs to the sheet. Membership and leases belong to the updater.

## R7. The registry (D1)

- **Decision**: New RPC `list_team_product_catalogs(p_team)` (`view`): live catalogs only — sheet
  material active and linked (`companion_kind = 'product_catalog'`), video material active — joined
  with the video's name and parent folder name, `product_count`, `created_at`, `last_updated_at`,
  `update_count`, `in_updater`, `last_update_error`. Filtering is client-side (a space has hundreds, not
  hundreds of thousands, of catalogs).
- **Rationale**: No list RPC exists; `get_material_product_catalog` is per video.

## R8. Live state for the panel (D1)

- **Decision**: No new realtime channel. Every updater state change (start, save, stop, round opened,
  item updated or failed) inserts a `team_catalog_events` row (`upserted`) for the affected sheet or,
  for updater-level changes, for any one catalog in it — the existing `useTeamRealtime` listener bumps
  `revision`, and `useCatalogUpdater(teamId)` refetches on `revision` (debounced) with a 60 s fallback
  poll (`useStorageHealth` pattern). The countdown is computed client-side from `next_run_at`, ticking
  in a leaf component (`two-factor/Countdown.tsx` pattern: 250 ms, re-sync on visibility/focus).
- **Rationale**: `team_catalog_events` is already in the realtime publication and already subscribed;
  a new table would need publication + a listener for no gain.

## R9. Web placement (D1)

- **Decision**:
  - **Chip** `CatalogUpdaterChip` in `.team-space-shell-utilities`
    (`apps/web/src/team/workspace/WorkspaceShell.tsx`), right before the space-settings link: an
    `<a class="ui-chip ui-chip-busy team-updater-chip">` (warn tone for attention), spinner, "running",
    countdown, catalog count, and with re-stitching "ready X/N"; `null` when stopped
    (`BackgroundWorkChip` pattern). Tabular numerals so the countdown does not jitter.
  - **Dialog** in the URL like settings: `updater=1` in `TeamRouteQuery` (`team/routes.ts`), rendered
    next to `SettingsDialog`. `Modal bare` with its own backdrop/class modelled on
    `team-preview-backdrop` / `team-preview-dialog`: header (title, status, close), toolbar (search from
    `.team-task-picker-search`, select-all-filtered checkbox, "N selected"), scrolling list (explorer
    `team-explorer-check` checkboxes, video name, folder, products, created, last update, "in updater"
    badge, open/copy), footer (`SegmentedControl` 1h/1d/1w, re-stitch checkbox, Start / Save / Stop).
    Edge-to-edge under 720 px.
- **Permissions**: view → see chip, dialog, registry; `process` → start, save, stop (FR-003).

## R10. Deleting used copies permanently (D2)

- **Decision**: New `GoogleDriveClient.deleteFile(fileId)` (`DELETE files/{id}`), callable only from the
  updater's code path and only for files recorded in `team_catalog_restitch_copies` — never for an
  arbitrary material id.
- **Rationale**: FR-017; `drive.file` allows deleting app-created files. Every other delete in the
  product stays a trash.

## R11. How the agent takes re-stitch work (D2)

- **Decision**: **Enrolled device** (design A from the research):
  1. A member picks "this computer re-stitches". The web (JWT) calls `updater-devices/enroll` with the
     agent install id, build and tool contracts; the server stores a device row with a **hashed** secret
     and returns the secret once; the web hands it to a new agent route
     `POST /api/team/updater/enroll` (session-token + entitlement gated); the agent stores it 0600 in
     its support dir.
  2. A new agent runner polls `updater-agent/claim` (header `x-soty-device-secret`) every 30–60 s with
     jitter, only when entitled, `acceptingNewTasks()`, and idle. On claim the server performs the
     `process/start` work **as the enrolling member** (operation, name reservation, `process_input` and
     `finalize` grants) and returns the same `TeamAgentProcessRequest` the web sends today plus
     `transferUrl` / `cloudBaseUrl` and restitch options (space defaults, prep).
  3. The runner calls `TeamProcessBridge.process({ toolId: 'restitch', … })` unchanged; heartbeats every
     25 s renew the lease, update `last_seen_at` (the panel's "online"), and return `cancel: true` so the
     runner cancels promptly.
  4. `process/output/finalize` commits the copy; server logic keyed by operation records it as the
     catalog's spare copy.
- **Rationale**: The only option that lets the server start work later (FR-016), show online state
  (FR-018) and cancel promptly (FR-019) without a tab. Drive access stays on existing short-lived,
  revocable, permission-rechecked grants; the new secret only unlocks claiming, is team- and
  device-scoped, hashed, and revocable.
- **Alternatives**: Reusing the `wat1` entitlement token — 12 h life refreshed only with a tab, no team
  or device scope, no revocation. Web pre-staging tickets — still needs a tab for later work, long TTLs.

## R12. Re-stitch as a Drive output (D2)

- **Decision**: `TOOL_RULES.restitch = { categories: ['video'], contractVersion: 1, outputMimeType:
'video/mp4' }` in `drive-ops`; factor `handleProcessStart` into a core callable with an explicit
  `actorId` (JWT route and device claim both use it). `TeamProcessBridge` passes the delegate's
  `discovered` prep through (dropped today); `STITCH_IMAGE_UNAVAILABLE` keeps its own reason.
  New capability `AGENT_TOOL_CONTRACTS.teamUpdaterRestitch: 1` with a `teamUpdaterRestitchSupported()`
  helper — **not** a `WEB_TOOL_REQUIREMENTS` key. The web's `startTeamAgentProcess` stops mapping
  unknown tools to the compressor contract.

## R13. Copies next to the video (D2)

- **Decision**: Name `<video stem> restitched <n>.mp4` (n = the catalog's update count + 1 at
  preparation), placed in the video's current folder, recorded in `team_catalog_restitch_copies`
  (`catalog_material_id`, `material_id`, `role spare|in_use`, `operation_id`). Never written as a new
  version of the original (a changed `driveVersion` would invalidate prep).

## R14. Web deploy reach

- **Decision**: State in the quickstart and release notes that the agent's local page (Safari) keeps
  its bundled web until a desktop release — D1's panel and dialog appear there only with the next
  desktop build (the 022 lesson).

## R15. Testing

- **Decision**: SQL with PGlite (`tests/support/team-db.ts`) for rounds, leases, ID counters,
  registry; the worker handler with injected deps (022's `product-catalog.ts` pattern); ID rule and
  row rebuild as pure tests; DOM tests for chip and dialog; beta validation with `next_run_at` pulled
  forward by SQL instead of waiting an hour (quickstart).
