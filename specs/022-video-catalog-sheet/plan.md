# Implementation Plan: Video Catalog Sheet

**Branch**: `022-video-catalog-sheet` (cut from `cd0faa6`, the released 1.1.1 state) | **Date**: 2026-09-15 |
**Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/022-video-catalog-sheet/spec.md`

## Summary

A video in the team space gets **Create catalog**: a dialog takes a link and a product count
(1–400, default 100), and the `drive-ops` Edge Function makes a native Google spreadsheet next to
the video from the owner's Meta catalog template — rows numbered 1…N, the space's title,
description, price (`N,00 USD`) and image link, the pasted link, and a per-row video link
`…?v=001…`. The video and the sheet are shared by link, the sheet is linked to the video as a
`product_catalog` companion, and the dialog returns the sheet link. Space managers set the four
values on a new **Catalog** settings tab. The catalog follows its video through rename, move and
trash via the web tail module.

The approach is shaped by one hard constraint: it must ship **without a desktop agent release**.
`verify-release.mjs` refuses a web deployment that touches `packages/shared/src`, `apps/agent`,
`packaging` or `config/production.env` since `v1.1.1`, so the feature lives entirely in a migration,
`supabase/functions` and `apps/web` (research R1). The sheet is produced as an in-memory XLSX
uploaded with Drive conversion, which keeps the existing `drive.file` scope and guarantees literal
text cells (R2).

## Technical Context

**Language/Version**: TypeScript (strict, ESM) — Deno for Edge Functions, React 19 + Vite 8 for
`apps/web`; PostgreSQL (Supabase) for the migration.

**Primary Dependencies**: existing only — `npm:@supabase/supabase-js@2` in functions, Google Drive
v3 REST through `_shared/drive.ts`, the released web's `components/ui.tsx` and `components/Modal.tsx`.
No new package (the XLSX/ZIP writer is our own, R2).

**Storage**: Supabase Postgres — two new tables (`team_product_catalog_settings`,
`team_product_catalogs`), one widened check constraint on `team_materials`; the sheet itself in the
space's Google Drive.

**Testing**: vitest in `tests/` (single fork on this machine); SQL through the PGlite harness
`tests/support/team-db.ts`; DOM tests with `// @vitest-environment jsdom`; XLSX read back with
`yauzl`; manual beta validation per [quickstart.md](quickstart.md).

**Target Platform**: Supabase Edge Runtime (Deno) + the web app in desktop browsers; independent of
the desktop agent's version or presence.

**Project Type**: web application (edge backend + SPA) inside the existing monorepo.

**Performance Goals**: confirm → link in < 15 s for 95% of attempts at any count ≤ 400 (SC-001):
five Drive calls (get video, permissions, multipart create, sheet permission, verify) plus three RPCs.

**Constraints**: no change under the agent-release inputs (R1); no new Drive scope (R2); no new
`TeamErrorCode` (R14); additive migration only; only UI primitives that exist in the released web (R10); none of the post-release UI work (R13).

**Scale/Scope**: ≤ 400 rows × 31 columns per sheet; XLSX body well under 1 MiB thanks to shared
strings; one catalog per video; four settings per space.

## Constitution Check

_GATE: evaluated before Phase 0 and re-checked after Phase 1 — result unchanged._

| Principle                                   | Verdict                  | How                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Type-safe contracts, boundary validation | **Deviation, justified** | Request body parsed from `unknown` into a discriminated result; RPC rows narrowed in `teamApi`. The limits and validators do **not** live in `@video-compressor/shared` (Principle I's default home) because that would force an agent release — see Complexity Tracking. Parity is proven by test.                                                     |
| II. One source of truth for release         | Pass                     | `release.ts`, `WEB_TOOL_REQUIREMENTS` and `AGENT_TOOL_CONTRACTS` untouched; quickstart §2 checks the gate paths are unchanged.                                                                                                                                                                                                                          |
| III. Security and least privilege           | Pass                     | New tables: RLS enabled and forced, `revoke all`; client functions `security definer`, `search_path = ''`, `private.can(… 'view' \| 'manage_metadata')`; service functions granted to `service_role` only. Handler re-checks `upload` on the folder and `edit` + `canShare` before sharing a video. No secret added.                                    |
| IV. Child-process orchestration             | N/A                      | No agent or child process involved.                                                                                                                                                                                                                                                                                                                     |
| V. HTTP API & error conventions             | Pass                     | Existing team envelope; stable machine codes from the existing vocabulary plus `details.reason` (R14); deliberate statuses (400/403/404/409/429/502/503).                                                                                                                                                                                               |
| VI. Frontend composition & state            | Pass, one note           | Functional components; `useI18n()` keys in `i18n.ts` (en + uk); Supabase through `teamApi`; realtime through the existing catalog `revision`. **No analytics event** in v1 (R12) — the event name is DB-constrained and not part of the ask.                                                                                                            |
| Stack & tooling                             | Pass                     | Prettier/ESLint; migration `YYYYMMDDHHMMSS_product_catalogs.sql` with `ROLLBACK.md`; `apps/web/src/lib/database.types.ts` regenerated from the beta database after `migration up` (`npx supabase gen types typescript --local --schema public`) — `npm run types:supabase` reads the **linked production** project, which will not have the tables yet. |
| Workflow gates                              | Pass                     | Tests in central `tests/`; CI runs `npm run verify` on the PR; locally only focused single-fork runs (machine limit).                                                                                                                                                                                                                                   |

## Project Structure

### Documentation (this feature)

```text
specs/022-video-catalog-sheet/
├── spec.md
├── findings.md                     # pre-spec code analysis
├── plan.md                         # this file
├── research.md                     # R0–R14
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── catalog-template.md         # the owner's template, column by column
│   ├── catalog-template.json       # the same, byte-exact header strings
│   └── product-catalog-api.md      # edge route + RPCs
├── checklists/requirements.md
└── tasks.md                        # next: /speckit-tasks
```

### Source Code (repository root)

```text
supabase/
├── migrations/
│   ├── <ts>_product_catalogs.sql           # NEW: widen companion_kind; settings + catalogs tables;
│   │                                       #      get/set settings, get_material_product_catalog,
│   │                                       #      service_get_team_product_catalog_settings,
│   │                                       #      service_link_product_catalog_companion
│   └── ROLLBACK.md                         # reverse steps appended
└── functions/
    ├── _shared/
    │   ├── product-catalog.ts              # NEW: template, limits, parsers, rows, names, links (no imports)
    │   ├── xlsx.ts                         # NEW: buildXlsx — stored ZIP, shared strings, CRC-32
    │   ├── link-sharing.ts                 # NEW: ensureAnyoneReader(drive, fileId)
    │   └── drive.ts                        # + createConvertedFile (multipart upload with conversion)
    └── drive-ops/
        ├── product-catalog.ts              # NEW: handleCreateProductCatalog
        └── index.ts                        # + route '/product-catalog/create'

apps/web/src/
├── api/team.ts                             # + createProductCatalog, getProductCatalog,
│                                           #   get/setProductCatalogSettings
├── lib/database.types.ts                   # regenerated
├── i18n.ts                                 # + en/uk keys (dialog, card, settings tab, errors via reason)
├── team/
│   ├── routes.ts                           # + 'product-catalog' in TEAM_SETTINGS_TABS
│   ├── materials/tail.ts                   # + catalog in MaterialTail; rename/move/trash; copy skips
│   ├── explorer/PreviewPane.tsx            # + Catalog block for videos
│   ├── explorer/RowActions.tsx             # + catalog actions for video rows
│   ├── catalog/MaterialRowMenu.tsx         # + catalog actions for video rows
│   ├── workspace/SpaceSettings.tsx         # + Catalog tab
│   └── product-catalog/                    # NEW
│       ├── limits.ts                       # web copy of the four limits + field validators
│       ├── CreateProductCatalogDialog.tsx
│       ├── VideoProductCatalogActions.tsx
│       └── ProductCatalogSettingsSection.tsx
└── styles.css                              # a few rules for the catalog block and dialog, in the file's existing variables

tests/
├── product-catalog-template.test.ts        # NEW: embedded template ≡ contracts JSON; row builder rules
├── product-catalog-xlsx.test.ts            # NEW: ZIP/XLSX structure, types, no <f>, hostile strings
├── product-catalog-parity.test.ts          # NEW: web limits ≡ edge limits
├── product-catalog-handler.test.ts         # NEW: request parsing, order of refusals, rollback (Drive/RPC mocked)
├── team-product-catalog-sql.test.ts        # NEW: RLS, permissions, link/race/re-create, getter
├── team-material-tail.test.ts              # + catalog cases
├── product-catalog-dialog.test.tsx         # NEW: validation, missing settings, result, existing outcome
└── product-catalog-settings-section.test.tsx # NEW: read-only vs manage_metadata, price/link validation
```

**Structure Decision**: No new app or package. Server logic joins `drive-ops` (which already owns
operations, destination proving and material finalize) in its own file; pure logic sits in
`supabase/functions/_shared` so both the function and vitest import it; web code gets one feature
folder `team/product-catalog/` and small hooks into the explorer, tail module and settings. Nothing
under `packages/shared`, `apps/agent` or `packaging` changes.

## Delivery sequence

1. **Schema** — migration + ROLLBACK + `types:supabase` + SQL tests.
2. **Pure core** — `product-catalog.ts`, `xlsx.ts` + template/xlsx/parity tests.
3. **Server** — `createConvertedFile`, `link-sharing.ts`, `handleCreateProductCatalog`, route +
   handler tests.
4. **Web data** — `teamApi` methods, `limits.ts`, tail changes + tail tests.
5. **Web UI** — settings tab (US2), dialog + card/row actions (US1, US3, US5) + DOM tests; i18n.
6. **Beta validation** — quickstart §3–7, including the formula-safety check that closes R2's
   verification debt.
7. **Rollout** — fast-forward `beta` to this branch, backend plan → exact-SHA packaged beta →
   backend apply → `deploy:web` (quickstart §8). No desktop build. Then merge into `main`.

## Risks

| Risk                                                                          | Mitigation                                                                                                                        |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Drive conversion treats a string cell differently from XLSX semantics         | Quickstart §5.5 on real Drive before rollout; fallback is the Sheets API `RAW` path (R2), which needs only the API enabled.       |
| Someone adds a shared-contract change "for convenience" during implementation | Quickstart §2 in the PR checklist; `deploy:web` itself refuses.                                                                   |
| 021 merges later and restyles every screen                                    | These files are ordinary pre-021 screens to it; 021's own migration covers them. Nothing here imports 021 files.                  |
| A `_shared/drive.ts` change redeploys every function importing it             | Expected; `release:backend-plan` lists them. `product-catalog.ts`, `xlsx.ts`, `link-sharing.ts` are imported by `drive-ops` only. |
| Edge wall-clock with 400 rows and a slow Drive                                | One upload call; the XLSX is built in memory in milliseconds; Drive client already times out at 15 s per call.                    |

## Complexity Tracking

| Violation                                                                                                                           | Why Needed                                                                                                                                              | Simpler Alternative Rejected Because                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Limits and validators duplicated in `supabase/functions/_shared` and `apps/web` instead of `@video-compressor/shared` (Principle I) | The owner requires shipping without an agent release; any change under `packages/shared/src` makes `verify-release.mjs` refuse the web deployment (R1). | One shared module — rejected: forces a full desktop release. Web importing the Deno module directly — rejected: Deno `.ts` specifiers and the web build's module rules; a parity test is the established pattern (`team-material-kind.test.ts`). |
| Error cases distinguished by `details.reason` rather than dedicated codes (Principle V)                                             | New codes are a `packages/shared` change (R14).                                                                                                         | New `TeamErrorCode` values — rejected for the same release reason; `details` is already part of the contract.                                                                                                                                    |
