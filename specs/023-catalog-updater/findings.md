# 023 — Findings from the pre-spec analysis

Gathered 2026-09-15 on `022-video-catalog-sheet` (released 1.1.1 + feature 022). What `/speckit-plan`
should start from.

## Re-stitching today (feature 015)

- Runs only on the desktop agent (FFmpeg pipeline from 014). Web entry: `deliverRestitched`
  (`apps/web/src/team/explorer/ExplorerShell.tsx`) → `useRestitchDelivery.deliver`
  (`apps/web/src/team/restitch/useRestitchDelivery.ts`): loads space defaults, checks the agent,
  asks for an agent download grant, and calls the agent download with `process: { tool: 'restitch' }`.
- The result is copied to a **local folder** (`apps/agent/src/team-bridge/download.ts`); nothing is
  uploaded to Drive. `apps/agent/src/team-bridge/restitch.ts` states the bridge never talks to the
  cloud; screen images come from the agent's **local** image library — the space stores only ids.
- Leaving the page aborts a delivery (FR-013 of 015). 015's spec lists automatic/scheduled re-stitch
  as out of scope — 023 reopens it.

## Uploading a re-stitched output to Drive

- No path: `TOOL_RULES` in `supabase/functions/drive-ops/index.ts` has no `restitch`;
  `handleProcessStart` refuses unknown tools.
- The agent side is close: `TeamProcessBridge` already has a `restitch` delegate and uploads results
  through `process/output/finalize` with the finalize grant (`apps/agent/src/team-bridge/transfer.ts`).
- Needs: a `TOOL_RULES.restitch` entry, finalize handling that records the output as the catalog's
  re-stitched copy, and a new **capability** in `AGENT_TOOL_CONTRACTS` (not a
  `WEB_TOOL_REQUIREMENTS` key, which would block `deploy:web` until a release) — i.e. a desktop
  release.

## Work without an open tab

- Team library processing is driven by the browser (`LibraryProcessingProvider.tsx`: claim, heartbeat,
  call the agent); closing the tab releases the lease.
- The agent never polls the server; it has an entitlement token and per-operation grants, no Supabase
  session. Server-side claim queues exist only for Edge Function workers (catalog-sync,
  preview-warm, archive inspections).
- A scheduled re-stitch without a tab therefore needs a new agent loop that claims re-stitch jobs,
  with an auth the agent can hold (e.g. a revocable updater grant issued when a member picks "this
  computer re-stitches"), plus a claim RPC for it — a desktop release.

## Server scheduling

- Pattern: `private.invoke_<x>_worker()` (security definer) reads URL + secret from
  `vault.decrypted_secrets`, no-ops if missing, `net.http_post` with an `x-<x>-secret` header;
  `cron.schedule` re-created idempotently. Catalog sync runs every 10 s with a "work due?" pre-check
  and a lease cap (`20260907140000_catalog_progress_keeps_its_lease.sql`); preview warm every 5 min
  (`20260827107000_preview_warm_schedule.sql`). Secret check on the function side:
  `_shared/auth.ts` (`x-catalog-sync-secret`). Beta writes the worker secrets on `beta:up`.

## Updating a sheet in place

- 022 creates sheets with `createConvertedFile` (multipart POST, XLSX → native Sheet).
- No helper updates **content with conversion**: `updateSmallFileContent` is a media PATCH (1 MB,
  15 s, no target mime). Needed: an `updateConvertedFile` (multipart PATCH to
  `upload/drive/v3/files/{id}` with the XLSX body) — verify on real Drive that the file stays a native
  Sheet with the same id/link. `drive.file` allows writing files the app created.

## Deleting

- Every "delete" in the codebase is `trashed: true`; no permanent delete exists. FR-017 asks for
  permanent deletion of used re-stitched copies → a new `files.delete` helper (allowed under
  `drive.file` for app-created files).

## Other

- A changed source `driveVersion` invalidates saved re-stitch prep (`usablePrep`); keep re-stitched
  copies as separate sibling files, never as new versions of the original.
- Feature 022 kept `packages/shared/src` untouched to stay web-only; 023's re-stitching part cannot,
  so plan it as two deliveries: (1) registry + updater + ID updates (server + web), (2) re-stitching
  with the desktop release.

## T004 — in-place rewrite proven on real Drive (2026-09-15)

On the beta's real Google Drive, `GoogleDriveClient.updateConvertedFile` (multipart PATCH,
`uploadType=multipart`, metadata `{ mimeType: 'application/vnd.google-apps.spreadsheet' }`, XLSX body)
rewrote a 022 catalog in place:

- the Drive file id and `webViewLink` were unchanged; the file stayed a native Google Sheet;
- Drive's `version` moved (13 → 15), nothing else about the file did;
- the signed-out CSV export showed column A as `501…504`, and every other cell as 022 wrote it;
- a second run with offset 0 restored the sheet exactly.

Research R4 stands; the Sheets API fallback is not needed. Script (scratchpad, not committed) used the
real `_shared/drive.ts`, `credentials.ts`, `product-catalog.ts`, `xlsx.ts` modules through `tsx`.

## Implementation notes (D1)

- **Tick every 10 seconds, 12 live leases, 3 sheets in parallel per invocation** — not the plan's
  "1 minute, 3 leases". At one minute and three leases a hundred catalogs would take about half an
  hour, past SC-001's five minutes. Idle ticks stay free: the invoker returns before any HTTP call
  when no updater is due and no retry is waiting (same shape as catalog-sync's 10-second tick).
- The updater's interval column is `update_interval` (`interval` is a SQL type name); the RPC payload
  still calls it `interval`.
- Updater-level changes write a `team_catalog_events` row with `event_kind = 'sync_state'` and no
  material; per-sheet updates write `upserted` for the sheet. The web's existing listener refetches on
  either.

## Worker proven end to end on the beta (2026-09-15)

With an updater row armed directly in the beta database for one live catalog and `next_run_at = now()`,
the 10-second cron invoked `catalog-updater` through the derived URL and the catalog-sync secret; the
worker rewrote the real sheet in place: IDs `1…4 → 501…504` within ~15 s, and after pulling the next
run forward again `→ 1002…1005` within ~20 s. Price, video links (`?v=001…`) and all 31 columns
unchanged; `update_count` 2; `next_run_at` one hour ahead. The updater was stopped afterwards.

Note: a new Edge Function is only served locally after `beta:down` + `beta:up` (the edge runtime
receives its function list at container creation). A stale `beta-up.mjs` supervisor from an earlier
session held port 5175 and made `beta:down` refuse ("borrowed"); stopping that supervisor with TERM
cleared it.

### D1 web UI (T013–T035)

- `useCatalogRegistry` lives in `useCatalogUpdater.ts` next to `useCatalogUpdater` instead of its own file (T016): both share one refresh loop (revision debounce 500 ms, 60 s floor), and a second file would have held one call.
- The chip is always present: a plain "Catalog updater" link while stopped, the busy/warn chip while running, so the header does not jump when the updater starts (T031 allowed either).
- Checkboxes reuse `.team-explorer-row-check.team-explorer-check` (the list-row variant); the bare `.team-explorer-check` is positioned for tiles.
- The countdown's server offset is taken per state read (`serverNow − Date.now()`); the chip test proves a 30 s skew moves the countdown by 30 s.

### Beta proof of the UI (T028, T036) — 2026-09-15

On the running beta (vite dev on the branch), signed in as the beta tester, Ukrainian UI:

- Header while stopped: "Оновлювач каталогів" link before "Налаштування простору". It opens `?updater=1`; Close returns to the explorer address.
- Registry: the one catalog on the beta, "Db3_1_compressed_3.mp4 · Офер1 · Товарів: 4 · Створено … · Оновлено …". Search "Db3", "Вибрати всі показані", 1 година, Запустити → toast "Оновлювач запущено", status "Працює · наступне оновлення через 0:59:58", badge "В оновлювачі".
- Header while running: "Оновлювач 0:59:16 1 каталог", counting down.
- Forced round (`next_run_at` moved to now + 5 s in SQL): within ~5 s the cron worker set `update_count` 3 and the published sheet's ID column read 1504…1507 (+1503 = 500·3 + 3), after 501… and 1002… earlier.
- Stop → nested confirmation → "Не запущено"; the header chip turned back into the plain link immediately; `state = stopped`, `next_run_at` null, 0 items.
- 400 px wide: the dialog fills the screen with no horizontal overflow.
- Two defects found and fixed here: the updater's backdrop sat on `--layer-fullbleed` (120), above the nested confirmation (`--layer-modal-nested`, 110), so Stop looked dead — it now uses `--layer-modal`; and the header chip waited for realtime after a start/stop — the dialog now calls `onChanged` so the shell re-reads at once.
- A trashed sheet leaving the updater (T036, step 6) is proven by the SQL test rather than on the beta, which holds a single catalog.

## Delivery 2 — implementation notes

Branch `023-catalog-updater-restitch` (from D1's `53bff4d`), so D1 stays deployable web-only while D2
waits for a desktop release.

Deviations from the plan, and why:

- **Enrolment is an RPC, not an Edge Function.** `enroll_team_updater_device` generates the secret
  (two `gen_random_uuid()` — 244 bits) and stores `sha256` of it; nothing in the enrolment needs Drive
  or a service key, so a function would only add a hop. `updater-devices` does not exist.
- **The device routes live in drive-ops, not a new `updater-agent` function.** drive-ops already takes
  grant-authenticated callers before `authorizeCaller` (`/process/output/*`), and claiming has to start
  a process as the device's member — `handleProcessStart(request, body, service, actorId)` already takes
  the actor. A separate function would have needed the `process-core` refactor (T040) or an HTTP hop
  with a service secret. The handlers are in `drive-ops/updater-device.ts` behind injected deps.
- **Cancellation deletes the job** instead of a `cancelled` state; `private.catalog_restitch_operations`
  remembers which operations the updater started, so an output finishing after a stop is recognised
  and retired rather than left behind.
- **Copies have a third role, `retired`**, and one deletion queue in the worker for every used or
  unwanted copy. A copy retired by a stop waits two minutes (longer than a round's lease), and
  `service_complete_catalog_update` brings a retired spare back to `in_use` if the round had already
  written its link — the sheet never points at a deleted file.
- **A permanently deleted copy's material becomes `missing`**, as a file deleted outside the product.
- **The runner reports discovery from the bridge result** (`TeamFileOperationResult.discovered`),
  and drops a preparation from another detector version itself (`RESTITCH_DETECTOR_VERSION`).
- **The runner claims only when every tool module is idle**, so the updater never slows a member's own
  compression; one job per computer at a time (SQL-enforced too).
- **"Video not refreshed" is not marked per sheet**; the chip turns to attention while re-stitching is
  on and the computer is away, and the dialog shows copies ready X of N.

### Beta proof of delivery 2 (T050) — 2026-09-15

Beta stack from `023-catalog-updater-restitch` (agent build 64, `teamUpdaterRestitch: 1`), the test catalog
"Db3_1_compressed_3" (4 products), space defaults set to stitch a 3-second end screen from an image
uploaded to the beta agent's library.

- Dialog, re-stitch ticked with no computer: the page enrolled this computer ("MacBook-Air-Roman
  (цей комп’ютер) · на зв’язку"), the agent stored the secret, Start sent `restitch: true`; "Готових копій:
  0 з 1".
- The agent claimed the job, re-stitched the video and uploaded it; finalize made it the spare, shared by
  link, and the inspection was stored (prep, detector 2).
- Forced round: IDs 2007…2010 (+2006, update 4), column Z → the spare's link; the spare became in use and
  the next job was queued at once.
- Second spare "restitched 5", forced round: update 5, Z → "restitched 5", the copy used before is
  `missing` in the catalog and **not found in Drive** (deleted, not trashed). The in-use copy opens signed
  out.
- Stop from the dialog while the third copy was finishing: it arrived as `retired`, was deleted two
  minutes later; the in-use copy and the sheet's links stayed.
- Not run on the beta: the computer going offline (step 5) — covered by the SQL and runner tests.

Found and fixed on the beta (`ce89e81`):

1. The runner read `job` from the top of drive-ops' answer, which is `{ ok, value }`; the fakes in its
   test had the same wrong shape. Every claim looked empty, the lease lapsed, the operation stayed open.
2. That open operation kept its name reserved: the retry failed `NAME_CONFLICT`. Claims now close every
   still-running operation the updater started for the catalog before starting another.
3. The process idempotency key was `updater-<job>-<attempt>`; a job is recreated after every spare, so
   attempts repeat — `WRONG_STATE`. The key now carries the lease.
4. **`SOURCE_CHANGED` at finalize for an unchanged video.** 022 shares the video by link, which moves its
   Drive version; the catalog row kept the old one, the process bound the live one, and finalize compared
   the row. `handleProcessStart` now refreshes a row whose checksum matches the live file
   (`service_refresh_material_revision`). **This also affects member-started processes on any video that
   has a 022 catalog, in production today**, unless catalog sync has since caught the version up.
5. Ticking re-stitch before the dialog's first read landed was overwritten by the initial-state effect; the
   option now waits for it.

Leftovers: the four failed uploads before fix 4 ("… restitched 4.mp4" … "(4)") sit in Drive next to the
test video, outside the catalog (operations in `reconcile_required`).
