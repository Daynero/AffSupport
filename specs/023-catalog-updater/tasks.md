---
description: 'Task list for 023 — Catalog Updater'
---

# Tasks: Catalog Updater

**Input**: `specs/023-catalog-updater/` — [plan.md](plan.md), [spec.md](spec.md),
[research.md](research.md), [data-model.md](data-model.md), [contracts/updater-api.md](contracts/updater-api.md),
[quickstart.md](quickstart.md), [findings.md](findings.md)

**Tests**: Included — the plan and quickstart name the test files; the constitution requires tests in
`tests/`.

**Two deliveries.** Phases 1–6 are **D1** (backend + web): they must not modify
`packages/shared/src`, `packages/shared/package.json`, `apps/agent`, `packaging` or
`config/production.env`, so `deploy:web` accepts them. Phase 7 is **D2** and ships with a desktop
release.

**Branch**: `023-catalog-updater`, cut from `022-video-catalog-sheet`. UI uses the release web's
`components/ui.tsx` and `components/Modal.tsx` (no 021 design system here).

**Machine rules**: before vitest/tsc/builds run `uptime` and `pgrep -fl "tsc|vitest|vite build"`; one
heavy process at a time with `nice -n 15`; vitest `--pool=forks --poolOptions.forks.singleFork=true`;
never `npm run verify`; never `supabase db reset` on the beta (`npx supabase migration up --local`).

**Tool quirk**: tool inputs decode `\uXXXX`; generate escape sequences with `chr(92)` in a script and
scan written files for control characters.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T001 Confirm the D1 gate on this branch — `git diff --name-only v1.1.1..HEAD -- apps/agent packaging packages/shared/src packages/shared/package.json config/production.env` prints nothing — and take the next free migration timestamp from `ls supabase/migrations | tail -2` (after `20260915010000`)
- [x] T002 Add `[functions.catalog-updater]` with `verify_jwt = false` to `supabase/config.toml`, next to `[functions.catalog-sync]`

---

## Phase 2: Foundational (blocks every story)

### Proof first

- [x] T003 Add `updateConvertedFile({ fileId, resourceKey, sourceMimeType, targetMimeType, bytes })` to `supabase/functions/_shared/drive.ts`: multipart `PATCH https://www.googleapis.com/upload/drive/v3/files/{id}?uploadType=multipart&supportsAllDrives=true&fields=FILE_FIELDS` (plus `resourceKey` when present), metadata part `{ "mimeType": targetMimeType }`, body = bytes, 10 MB cap (`TOO_LARGE`), 60 s timeout; `INVALID_RESPONSE` unless the returned `id` equals `fileId` and `mimeType` equals `targetMimeType`. Build the multipart body the way `createConvertedFile` does
- [x] T004 **Verify on real Drive (beta) that in-place conversion keeps the sheet**, before building on it. In the session scratchpad (never the repo), write a Node script that: reads the beta space's credential through the local service-role RPC `read_google_drive_credential` (keys from `npx supabase status -o env`, cached in the scratchpad, never printed); refreshes an access token at `https://oauth2.googleapis.com/token` with `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` from `supabase/functions/.env` (never printed); rebuilds one existing 022 catalog's rows with column A shifted by 500 by importing `supabase/functions/_shared/product-catalog.ts` and `xlsx.ts` through `tsx` or a small vitest file run once; and sends the same multipart PATCH as T003. Confirm the Drive id and URL are unchanged, `https://docs.google.com/spreadsheets/d/<id>/export?format=csv` still works signed out, and column A starts at 501; then run it again with offset 0 to restore the sheet. If the id or type changes, STOP and report — research R4's fallback (Sheets API) replaces T003. Record the result in `specs/023-catalog-updater/findings.md`

### Pure core

- [x] T005 [P] Write `supabase/functions/_shared/catalog-updater.ts` (no imports except `./product-catalog.ts` types): `idOffset(updateCount: number): number` = `500·k + k·(k−1)/2`; `UPDATER_INTERVALS = { '1h': 3600, '1d': 86400, '1w': 604800 }` (seconds) and `parseUpdaterInterval(unknown)`; `rebuildCatalogRows({ record, updateCount, videoLinkOverride })` that calls `buildProductCatalogRows` and replaces column A with `row + idOffset(updateCount)` and, when `videoLinkOverride` is given, column Z with `override + '?v=' + 3-digit row`
- [x] T006 [P] Keep 022's `buildProductCatalogRows` untouched: `rebuildCatalogRows` replaces cells in its output. Add a test in `tests/product-catalog-template.test.ts` that 022's rows are unchanged by importing the updater module (guards against accidental edits)
- [x] T007 [P] Write `tests/catalog-updater-ids.test.ts`: `idOffset(0..3) = 0, 500, 1001, 1503`; a 100-row sheet reads `1…100 → 501…600 → 1002…1101 → 1504…1603`; 2000 successive updates of 400 rows never repeat an ID; every column other than A (and Z when overridden) equals 022's rows cell for cell; interval parser accepts only `1h|1d|1w`
- [x] T008 [P] Write `apps/web/src/team/catalog-updater/limits.ts` (web mirror: intervals, `idOffset`) and `tests/catalog-updater-parity.test.ts` asserting it equals the Edge module

### Schema

- [x] T009 Write `supabase/migrations/<ts>_catalog_updater.sql` per data-model D1: new columns on `team_product_catalogs` (`update_count`, `last_updated_at`, `last_update_error`); tables `team_catalog_updaters`, `team_catalog_updater_items` (RLS enabled + forced, `revoke all`, select policies `private.can(team_id,'view',auth.uid())` with column grants); functions `list_team_product_catalogs`, `get_team_catalog_updater` (includes `serverNow`), `save_team_catalog_updater`, `stop_team_catalog_updater`, `service_open_catalog_updater_rounds`, `service_claim_catalog_updater_items` (advisory lock, 3-lease cap, `for update skip locked`, lease 10–300 s, `next_attempt_at` = lease end, join `team_drive_connections` state `connected|unavailable` for `credential_id`, drop items whose sheet or video is no longer live with a `team_catalog_events` row), `service_complete_catalog_update`, `service_retry_catalog_update`; `private.invoke_catalog_updater_worker()` (early exits: no running updater due and no item due, or 3 live leases; secret `wishly_catalog_sync_secret`; URL = `wishly_catalog_sync_url` with trailing `/catalog-sync` replaced by `/catalog-updater`, no-op unless the result ends in `/catalog-updater`; `net.http_post` with `x-catalog-sync-secret`, 60 s); `cron.unschedule` + `cron.schedule('wishly-catalog-updater', '1 minute', …)`; every state change inserts `team_catalog_events (…, 'upserted')`; grants exactly as data-model
- [x] T010 Append reverse steps for T009 to `supabase/migrations/ROLLBACK.md`
- [x] T011 Write `tests/team-catalog-updater-sql.test.ts` (PGlite, style of `tests/team-product-catalog-sql.test.ts`): registry lists only live catalogs with folder name and counters; `save` refuses without `process`, with an empty list, a catalog of another space, interval `2h`, `restitch = true`; start sets `next_run_at ≈ now + interval`; changing the interval resets it, changing only the list does not; `open_rounds` stamps items once and advances `next_run_at` by one interval even when overdue by many; claim respects leases and the cap; `complete`/`retry` fail on a lost lease; `update_count` survives removing and re-adding a catalog; `stop` clears items and `next_run_at`; invoker URL derivation for `http://kong:8000/functions/v1/catalog-sync` and `https://<ref>.supabase.co/functions/v1/catalog-sync`
- [x] T012 Apply T009 to the running beta with `npx supabase migration up --local`; add the four client RPCs to `apps/web/src/lib/database.types.ts` by hand, shapes from `npx supabase gen types typescript --local --schema public`

**Checkpoint**: T004 proven; T007, T011, parity green.

---

## Phase 3: User Story 1 — See and manage all catalogs (P1) 🎯

**Goal**: A full-screen dialog lists every live catalog with search, open and copy.

**Independent test**: quickstart §5 steps 1 — open the dialog, find a catalog by part of its video name, open and copy.

- [ ] T013 [P] [US1] Add to `apps/web/src/api/team.ts`: `CatalogRegistryRow`, `CatalogUpdaterState` types (contract) and `listTeamProductCatalogs(teamId)`, `getCatalogUpdater(teamId)` narrowing rows from `unknown`
- [ ] T014 [P] [US1] Add `updater` to `TeamRouteQuery`, `emptyTeamRouteQuery`, `parseTeamRoute` (`updater=1`) and `buildTeamRoute` (explorer branch) in `apps/web/src/team/routes.ts`; extend `tests/team-routes.test.ts`
- [ ] T015 [P] [US1] Add en/uk keys to `apps/web/src/i18n.ts`: dialog title, search placeholder, empty/loading/error, column labels (video, folder, products, created, updated, in updater), open/copy, plural catalog counts `catalogUpdaterCatalogsOne/Few/Many` with a `catalogCountKey` helper next to `selectedCountKey`; extend `tests/i18n-plurals.test.ts`
- [ ] T016 [US1] Write `apps/web/src/team/catalog-updater/useCatalogRegistry.ts`: read on open, refetch on `revision` (500 ms debounce), 60 s fallback poll, client-side filter by video and catalog name (case-insensitive, trimmed)
- [ ] T017 [US1] Write `apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx` (registry part): `Modal bare` with `backdropClassName="team-updater-backdrop"`, `className="team-updater-dialog"`, header (title, close), toolbar (search in the `.team-task-picker-search` style), scrolling list rows (video name, folder or "space root", products, created, last update, "in updater" badge, open link `target=_blank`, copy with toast); edge-to-edge below 720 px
- [ ] T018 [US1] Render the dialog in `apps/web/src/team/workspace/WorkspaceShell.tsx` when `query.updater` is set (next to `SettingsDialog`), closing via `navigateTo(explorerRoute({ updater: false }))`; add an entry point "Catalog updater" link in `.team-space-shell-utilities` before the settings link (visible to `view`)
- [ ] T019 [P] [US1] Add dialog styles to `apps/web/src/styles.css`: `.team-updater-backdrop`, `.team-updater-dialog` (grid rows header/toolbar/list/footer, width `var(--dialog-wide)`, height `min(92vh, …)`, list `overflow-y: auto`), row layout, narrow-screen full-bleed
- [ ] T020 [P] [US1] Write `tests/catalog-updater-dialog.test.tsx` (registry): lists rows, search narrows and clearing restores, open href and copy, empty state

---

## Phase 4: User Story 2 — Start an updater (P1)

**Goal**: Tick catalogs, choose 1h/1d/1w, start; the server updates sheets in place at each round.

**Independent test**: quickstart §5 steps 2–5 on the beta, `next_run_at` pulled forward.

- [ ] T021 [US2] Write `supabase/functions/catalog-updater/worker.ts`: `runCatalogUpdaterTick(deps, { budgetMs })` with injected deps (`openRounds`, `claimItems`, `driveFor(credentialId)`, `complete`, `retry`, `markNeedsReauth`, `now`, `log`): open rounds, claim up to 10, per item rebuild rows (`rebuildCatalogRows` with `updateCount + 1`), `buildXlsx`, `updateConvertedFile`, `complete(item, updateCount + 1)`; on error `retry` with back-off 1, 5, 15 min then 15 min; `NEEDS_REAUTH` → `markNeedsReauth`; stop claiming when the budget is spent; returns `{ rounds, claimed, updated, failed }`
- [ ] T022 [US2] Write `supabase/functions/catalog-updater/index.ts`: CORS-free `Deno.serve`, `requireNamedWorkerSecret(request)` (defaults), `requireDriveOAuthGate`, service client, deps bound to the SQL functions from T009 and a per-credential Drive client cache (`preview-warm` `driveFor` pattern, `readDriveCredential` + `refreshGoogleAccessToken`), budget 8000 ms
- [ ] T023 [P] [US2] Write `tests/catalog-updater-worker.test.ts`: round then update writes shifted IDs and calls complete with count+1; a Drive failure retries only that item and others still complete; lost lease on complete is logged, not thrown further; budget stops claiming; `NEEDS_REAUTH` marks the credential
- [ ] T024 [P] [US2] Add `saveCatalogUpdater(teamId, { catalogIds, interval, restitch })` and `stopCatalogUpdater(teamId)` to `apps/web/src/api/team.ts`
- [ ] T025 [US2] Add the selection and start controls to `CatalogUpdaterDialog.tsx`: per-row checkboxes (`team-explorer-check` style), "select all matching" checkbox for the filtered rows with indeterminate state, "N selected", footer with `SegmentedControl` (1 hour / 1 day / 1 week), a disabled "Re-stitch video" checkbox with the note that it needs the desktop app update (D1), Start disabled with a reason when nothing is selected or without `can('process')`; after start, the header shows the countdown to the first round
- [ ] T026 [P] [US2] Add en/uk keys for selection, intervals, re-stitch note, start/save/stop, reasons, running status to `apps/web/src/i18n.ts`
- [ ] T027 [P] [US2] Extend `tests/catalog-updater-dialog.test.tsx`: select-all selects only filtered rows; Start disabled with no selection and for a viewer; Start sends `{ catalogIds, interval: '1h', restitch: false }`
- [ ] T028 [US2] Beta validation per quickstart §3–5 steps 1–5 (in place, same links, `501…` then `1002…`); record results in `findings.md`

---

## Phase 5: User Story 3 — The panel (P1)

**Goal**: A chip beside the space settings shows running, countdown, catalog count, attention.

**Independent test**: quickstart §5 step 2 — chip counts down, click reopens the dialog.

- [ ] T029 [US3] Write `apps/web/src/team/catalog-updater/useCatalogUpdater.ts`: `getCatalogUpdater` on mount, on `revision` (debounced), 60 s poll; keeps `serverOffsetMs = serverNow − Date.now()` for the countdown
- [ ] T030 [P] [US3] Write `apps/web/src/team/catalog-updater/UpdaterCountdown.tsx`: leaf component, 250 ms tick, re-sync on `visibilitychange`/`focus` (`two-factor/Countdown.tsx` pattern), `H:MM:SS` under a day and `Dd HH:MM` above, tabular numerals
- [ ] T031 [US3] Write `apps/web/src/team/catalog-updater/CatalogUpdaterChip.tsx`: `null` when stopped; `<a className="ui-chip ui-chip-busy team-updater-chip">` (warn tone when `failingCount > 0`) with spinner, running label, `UpdaterCountdown`, plural catalog count; `href` = `explorerRoute({ updater: true })` with the in-app click handler; replace the T018 plain link with this chip while running (keep a plain "Catalog updater" link when stopped)
- [ ] T032 [P] [US3] Chip styles in `apps/web/src/styles.css` modelled on `.team-storage-chip` / `.team-background-chip` (opaque surface, ellipsis, hover accent)
- [ ] T033 [P] [US3] Write `tests/catalog-updater-chip.test.tsx` (fake timers): hidden when stopped; shows count and a countdown that decreases each second; warn tone when failing; link opens the updater route; re-reads on `revision`

---

## Phase 6: User Story 4 — Change or stop a running updater (P2)

**Goal**: Edit selection/interval or stop a running updater.

**Independent test**: quickstart §5 steps 6–7.

- [ ] T034 [US4] In `CatalogUpdaterDialog.tsx`, when running: preselect catalogs in the updater, "Save changes" (calls save; interval change restarts the countdown), "Stop" behind a confirmation modal (`nested`), and per-catalog failure text from `lastUpdateError`
- [ ] T035 [P] [US4] Extend `tests/catalog-updater-dialog.test.tsx`: running state preselects; save sends the new list; stop confirms then calls stop and the chip disappears
- [ ] T036 [US4] Beta validation per quickstart §5 steps 6–7 (a trashed sheet leaves the updater; stop ends rounds)

---

## Phase 7: User Story 5 — Re-stitched videos behind the catalog (P2) — **D2, desktop release**

**Goal**: An enrolled computer keeps one spare re-stitched copy per catalog; rounds swap sheet links to it and delete the used copy.

**Independent test**: quickstart D2 steps 1–6.

### Server

- [ ] T037 [US5] Write `supabase/migrations/<ts>_catalog_updater_restitch.sql` per data-model D2: `team_updater_devices` (private, hashed secret), `team_catalog_restitch_copies`, `private.catalog_restitch_jobs`, `team_product_catalogs.current_video_link`; RPCs: device projection for the dialog, enroll (revokes the previous device), claim/heartbeat/complete scoped to the device and re-checking `private.can` and account status, job creation on start/add/restitch-on/after consumption, cancellation on stop/remove/restitch-off; `save_team_catalog_updater` accepts `restitch = true` only with an online device whose contracts include `teamUpdaterRestitch ≥ 1`; `service_open_catalog_updater_rounds` returns the spare to swap per item; ROLLBACK steps
- [ ] T038 [P] [US5] Write `tests/team-catalog-restitch-sql.test.ts`: device secret hash compare, revocation, one spare + one in-use per catalog, jobs created/cancelled on each transition, claim only for the right device and live member
- [ ] T039 [US5] Add `deleteFile(fileId)` to `supabase/functions/_shared/drive.ts` (`DELETE files/{id}?supportsAllDrives=true`), and a guard in the worker that only deletes ids returned by the SQL as the catalog's retired copy
- [ ] T040 [US5] Factor `handleProcessStart` in `supabase/functions/drive-ops/index.ts` into `supabase/functions/drive-ops/process-core.ts` taking an explicit `actorId`; add `TOOL_RULES.restitch = { categories: ['video'], contractVersion: 1, outputMimeType: 'video/mp4' }`; at `process/output/finalize` for a restitch operation that belongs to a catalog job, record the output in `team_catalog_restitch_copies` as `spare` and share it by link (`ensureAnyoneReader`)
- [ ] T041 [US5] Write `supabase/functions/updater-devices/index.ts` (JWT; enroll per contract) and `supabase/functions/updater-agent/index.ts` (device secret header; claim → mint grants via `process-core` as the device actor; heartbeat → lease renewal + `cancel`; complete → prep data and failure reason); config.toml entries
- [ ] T042 [P] [US5] Write `tests/updater-agent-functions.test.ts` with injected deps: wrong or revoked secret refused; claim returns a `TeamAgentProcessRequest`-shaped job; heartbeat returns cancel after stop; complete records the reason
- [ ] T043 [US5] Extend `supabase/functions/catalog-updater/worker.ts`: when an item has a ready spare, rebuild with `videoLinkOverride` = the spare's shared link, commit, then delete the previous in-use copy and queue the next job; without a ready spare, IDs only and a "video not refreshed" mark; extend `tests/catalog-updater-worker.test.ts`

### Agent (desktop release)

- [ ] T044 [US5] Add `teamUpdaterRestitch: 1` to `AGENT_TOOL_CONTRACTS` and `teamUpdaterRestitchSupported()` in `packages/shared/src/release.ts` (not `WEB_TOOL_REQUIREMENTS`); rebuild shared
- [ ] T045 [US5] Write `apps/agent/src/team-bridge/updater-credential.ts` (0600 JSON in `applicationSupportRoot()`, `{ deviceId, secret, cloudBaseUrl }`, never logged) and the enroll/unenroll routes in `apps/agent/src/team-bridge/routes.ts` (session token + entitlement gated)
- [ ] T046 [US5] Write `apps/agent/src/team-bridge/updater-runner.ts`: poll claim every 30–60 s with jitter while enrolled, entitled, `acceptingNewTasks()` and idle; back off on network errors; run `TeamProcessBridge.process({ toolId: 'restitch', … })`; heartbeat every 25 s, cancel on `cancel: true` or lost lease; complete with outcome and `discovered`; count in the team module's `busy()` and `shutdown()`; register in `apps/agent/src/index.ts`
- [ ] T047 [US5] In `apps/agent/src/team-bridge/process.ts` pass the delegate's `discovered` through; in `apps/agent/src/team-bridge/restitch.ts` keep `STITCH_IMAGE_UNAVAILABLE` as its own reason
- [ ] T048 [P] [US5] Write `tests/agent-updater-runner.test.ts` (mkdtemp store, mocked fetch and bridge): no claim when not enrolled/busy/draining; claim → process → complete; cancel on heartbeat; credential file mode 0600

### Web

- [ ] T049 [US5] Write `apps/web/src/team/catalog-updater/RestitchDevicePicker.tsx` and wire the "Re-stitch video" checkbox in `CatalogUpdaterDialog.tsx`: enroll this computer (web → `updater-devices/enroll` → agent enroll route), show computer label, online, too-old; chip shows "ready X/N"; en/uk keys; tests in `tests/catalog-updater-dialog.test.tsx` and `tests/catalog-updater-chip.test.tsx`
- [ ] T050 [US5] Beta validation with a packaged agent per quickstart D2 steps 1–6; record in `findings.md`

---

## Phase 8: Polish & delivery

- [ ] T051 Prettier + ESLint on changed files; `nice -n 15 npx tsc -b apps/web`; `nice -n 15 npx tsc -p tsconfig.check.json --noEmit` (one at a time)
- [ ] T052 Focused tests from quickstart §1 plus existing tests touching `WorkspaceShell`, `routes`, `i18n`, `team-product-catalog-sql` — in batches, single fork
- [ ] T053 [P] Update `specs/023-catalog-updater/findings.md` and mark tasks
- [ ] T054 Commit per phase and push `023-catalog-updater` only (never `beta`/`main` without the owner)
- [ ] T055 **Owner-confirmed only** — D1 rollout like 022 (fast-forward `beta`, packaged beta verify, backend plan including the new function and migration, backend apply, `deploy:web` via an agent with production permission); D2 rollout with the next desktop release

---

## Dependencies

- Phase 1 → Phase 2. **T004 gates everything after it**: if in-place conversion does not keep the sheet, R4's fallback replaces T003 before Phase 4.
- US1 (Phase 3) needs T009–T013. US2 needs US1's dialog (T017) and T005, T009, T021–T022. US3 needs T029 (state RPC from T009) and the dialog route (T014). US4 needs US2. US5 (D2) needs US2 and US4 and a desktop release.

## Parallel opportunities

- Phase 2: T005, T007, T008 alongside T009/T011 (different files); T003 before T004.
- US1: T013, T014, T015, T019, T020 in parallel; T016 → T017 → T018.
- US2: T023, T024, T026, T027 alongside T021/T025.
- US3: T030, T032, T033 in parallel with T029 → T031.
- D2: server (T037–T043), agent (T044–T048) and web (T049) tracks run in parallel after T037.
- Writing in parallel is fine; running tests or builds is strictly one at a time on this machine.

## Implementation strategy

1. Phases 1–2 with T004 proven.
2. US1 + US2 + US3 = the D1 MVP: catalogs renew on schedule with a visible countdown.
3. US4, then D1 rollout on the owner's go.
4. US5 (D2) with the desktop release.
