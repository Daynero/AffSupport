# Implementation Plan: Catalog Updater

**Branch**: `023-catalog-updater` (cut from `022-video-catalog-sheet`) | **Date**: 2026-09-15 |
**Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/023-catalog-updater/spec.md`

## Summary

Feature 022's catalogs renew themselves. A space gets one server-side updater: a set of catalogs, an
interval (1 h / 1 d / 1 w) and an optional re-stitch. On each round a scheduled Edge Function rewrites
every selected sheet **in place** — same file, same link — shifting every product ID by the owner's
rule (+500, +501, +502…). A registry lists every live catalog; a full-screen dialog (in the URL,
like settings) selects catalogs and starts or stops the updater; a chip beside the space settings
counts down to the next round.

Re-stitching needs the member's desktop app, which today never takes work from the server, so it is a
second delivery: an enrolled "this computer re-stitches" device polls for jobs with a hashed,
revocable, team-scoped secret, runs the existing `restitch` delegate through `TeamProcessBridge`,
uploads the copy into Drive next to the video through the existing grants, and the next round swaps
the sheet's video links to it and deletes the copy used before.

- **D1 — backend + web** (no desktop release): registry, updater, rounds and ID updates, chip,
  dialog.
- **D2 — with a desktop release**: device enrollment, agent job runner, re-stitch as a Drive output,
  spare-copy lifecycle.

## Technical Context

**Language/Version**: TypeScript (strict, ESM) — Deno Edge Functions, React 19 + Vite 8 web, Node 22
agent (D2); PostgreSQL with `pg_cron`, `pg_net`, Vault.

**Primary Dependencies**: existing only — `npm:@supabase/supabase-js@2`, Google Drive v3 via
`_shared/drive.ts`, 022's `_shared/product-catalog.ts` + `_shared/xlsx.ts`, the release web's
`components/ui.tsx` / `Modal.tsx`; D2: agent `TeamProcessBridge`, `restitch` delegate, `PowerGovernor`.

**Storage**: new `team_catalog_updaters`, `team_catalog_updater_items`; new columns on
`team_product_catalogs`; D2 `team_updater_devices`, `team_catalog_restitch_copies`,
`private.catalog_restitch_jobs`. Sheets and copies in the space's Google Drive.

**Testing**: vitest in `tests/` (single fork); PGlite for SQL; injected-deps worker tests; jsdom DOM
tests; beta validation with `next_run_at` pulled forward ([quickstart.md](quickstart.md)).

**Target Platform**: Supabase Edge Runtime + web; D2 also the macOS and Windows desktop agent.

**Project Type**: web app (edge backend + SPA) + desktop agent, in the existing monorepo.

**Performance Goals**: every catalog of a due round updated within 5 minutes (SC-001): cron every
minute, ~8 s per invocation, 10 items per claim, 3 concurrent leases.

**Constraints**: D1 must not touch `packages/shared/src`, `apps/agent`, `packaging`,
`config/production.env` (web-only deploy gate); no new production secret (reuse
`CATALOG_SYNC_SECRET`, derive the worker URL); sheets keep their Drive id and link; additive
migrations; no new `TeamErrorCode`.

**Scale/Scope**: one updater per space; hundreds of catalogs per space; ≤ 400 rows per sheet; one
enrolled device per space (D2).

## Constitution Check

_GATE: evaluated before Phase 0 and after Phase 1 — unchanged._

| Principle                           | Verdict           | How                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Type-safe boundary validation    | Pass (D1 as 022)  | Worker, RPC rows and device payloads parsed from `unknown`. D1 keeps limits/ID rule in `supabase/functions/_shared` with a web mirror and a parity test (022 precedent); D2 may move them into `@video-compressor/shared` since it releases the desktop anyway.                                                                                                 |
| II. One source of truth for release | Pass              | D1: no contract change. D2: `AGENT_TOOL_CONTRACTS.teamUpdaterRestitch` capability, not `WEB_TOOL_REQUIREMENTS`; shipped by a normal release.                                                                                                                                                                                                                    |
| III. Security and least privilege   | Pass, review item | RLS + forced, `security definer` + `search_path = ''`, `private.can`. Worker authenticated by the existing secret. D2 device secret: random, returned once, stored as SHA-256 only, constant-time compare, team- and purpose-scoped, revocable, agent copy 0600, never in a tracked file; Drive access still via per-operation grants that re-check membership. |
| IV. Child-process orchestration     | Pass (D2)         | The runner calls `TeamProcessBridge`, which spawns through the governor; the runner counts in `busy`/`shutdown`, respects `acceptingNewTasks()`, and never suspends children itself.                                                                                                                                                                            |
| V. HTTP API & error conventions     | Pass              | Existing envelopes and codes with `details.reason`; worker and device endpoints return stable machine codes.                                                                                                                                                                                                                                                    |
| VI. Frontend composition & state    | Pass              | Hooks with debounced `revision` refetch + fallback poll; countdown in a leaf component; i18n en/uk with plural keys; no new data library.                                                                                                                                                                                                                       |
| Workflow gates                      | Pass              | Tests in `tests/`; CI runs verify; local focused single-fork runs.                                                                                                                                                                                                                                                                                              |

## Project Structure

### Documentation

```text
specs/023-catalog-updater/
├── spec.md · findings.md · plan.md · research.md · data-model.md · quickstart.md
├── contracts/updater-api.md
├── checklists/requirements.md
└── tasks.md            # next: /speckit-tasks
```

### Source code

```text
supabase/
├── config.toml                                   # D1 [functions.catalog-updater] verify_jwt = false
├── migrations/
│   ├── <ts>_catalog_updater.sql                  # D1 tables, columns, RPCs, service fns, cron invoker
│   └── <ts>_catalog_updater_restitch.sql         # D2 devices, copies, jobs, RPCs
└── functions/
    ├── _shared/
    │   ├── catalog-updater.ts                    # D1 pure: ID offset, row rebuild with shifted IDs / link
    │   ├── drive.ts                              # D1 updateConvertedFile; D2 deleteFile
    │   └── product-catalog.ts                    # D1 buildProductCatalogRows gains an id offset + link override
    ├── catalog-updater/index.ts, worker.ts       # D1 scheduled worker (deps injected)
    ├── drive-ops/index.ts, process-core.ts       # D2 TOOL_RULES.restitch, process/start core with actorId, finalize → spare copy
    ├── updater-devices/index.ts                  # D2 enroll (JWT)
    └── updater-agent/index.ts                    # D2 claim / heartbeat / complete (device secret)

apps/web/src/
├── api/team.ts                                   # D1 registry + updater RPCs; D2 device enroll
├── i18n.ts                                       # en/uk, plural catalog counts
├── styles.css                                    # chip + full-screen dialog
└── team/
    ├── routes.ts                                 # D1 updater=1
    ├── workspace/WorkspaceShell.tsx              # D1 chip in utilities, dialog next to SettingsDialog
    └── catalog-updater/                          # D1 useCatalogRegistry, useCatalogUpdater, CatalogUpdaterChip,
        │                                         #    UpdaterCountdown, CatalogUpdaterDialog, limits/ids mirror
        └── RestitchDevicePicker.tsx              # D2

apps/agent/src/team-bridge/                       # D2
├── updater-runner.ts                             # claim → TeamProcessBridge → heartbeat/cancel → complete
├── updater-credential.ts                         # 0600 store
├── process.ts                                    # pass `discovered` through
└── routes.ts                                     # /api/team/updater/enroll
packages/shared/src/release.ts                    # D2 teamUpdaterRestitch capability + helper

tests/
├── catalog-updater-ids.test.ts                   # D1
├── team-catalog-updater-sql.test.ts              # D1
├── catalog-updater-worker.test.ts                # D1
├── catalog-updater-parity.test.ts                # D1
├── catalog-updater-chip.test.tsx                 # D1
├── catalog-updater-dialog.test.tsx               # D1
├── team-catalog-restitch-sql.test.ts             # D2
├── updater-agent-functions.test.ts               # D2
└── agent-updater-runner.test.ts                  # D2
```

**Structure Decision**: One new Edge Function per trust boundary — `catalog-updater` (worker
secret), `updater-devices` (user JWT), `updater-agent` (device secret) — so no function mixes
callers. Web code in one feature folder plus two hook points in the shell and routes. Agent code as a
runner module beside the existing team bridges.

## Delivery sequence

**D1 (backend + web)**

1. Migration + SQL tests (rounds, leases, counters, registry, permissions).
2. `_shared/catalog-updater.ts` + `updateConvertedFile` + ID/rebuild tests.
3. **Prove in-place update on real Drive** (quickstart §3) before building on it.
4. `catalog-updater` worker + tests; cron invoker.
5. Web: API, routes, chip, dialog, i18n + DOM tests.
6. Beta end to end (quickstart §4–5).
7. Rollout like 022: fast-forward `beta`, packaged beta verify, backend plan/apply, `deploy:web`.

**D2 (with a desktop release)** 8. Device, copy and job schema + SQL tests; `deleteFile`. 9. `process/start` core with explicit actor; `TOOL_RULES.restitch`; finalize → spare copy. 10. `updater-devices` and `updater-agent` functions + tests. 11. Agent: credential store, enroll route, runner, `discovered` passthrough, capability; tests. 12. Worker rounds swap to spare copies and delete the previous in-use copy. 13. Web: device picker, online/too-old state, "ready X/N". 14. Beta with a packaged agent (quickstart D2); release through the runner.

## Risks

| Risk                                                            | Mitigation                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Multipart PATCH with conversion changes the file id or type     | Proven first on beta (step 3); fallback Sheets API `values.update RAW`.                                 |
| Worker URL derivation breaks if the Vault URL has another shape | Invoker no-ops unless the derived URL ends in `/catalog-updater`; SQL test on both beta and prod forms. |
| A long-lived device secret                                      | Hash only, scoped, revocable, rotated on enroll; claims re-check membership and account status.         |
| The re-stitching computer sleeps or is offline                  | Rounds never wait for it (IDs still update); leases expire and re-queue; attention state.               |
| Permanent deletion of the wrong file                            | `deleteFile` only accepts ids recorded as the updater's copies; SQL-level role check.                   |
| Local agent page (Safari) not updated by `deploy:web`           | Stated in quickstart and release notes (022 lesson).                                                    |
| Quota / Drive rate limits with many catalogs                    | 10 per claim, 3 leases, back-off on `RATE_LIMITED`.                                                     |

## Complexity Tracking

| Violation                                                                                       | Why Needed                                                                              | Simpler Alternative Rejected Because                                                                       |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| D1 rules mirrored in `supabase/functions/_shared` and web instead of `@video-compressor/shared` | D1 must ship without a desktop release (web-only deploy gate), as 022 did.              | Shared package — forces a desktop release for D1.                                                          |
| A new long-lived credential type (device secret, D2)                                            | Server-initiated re-stitch without a tab (FR-016, FR-018, FR-019).                      | Entitlement token — 12 h, unscoped, unrevocable; web-staged tickets — still need a tab, long-lived grants. |
| Three new Edge Functions                                                                        | One per caller type keeps worker, user and device authentication from sharing a router. | Routes inside `drive-ops` — mixes JWT, worker-secret and device-secret callers in one handler.             |
