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
