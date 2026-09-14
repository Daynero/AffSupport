---
description: 'Task list for 022 — Video Catalog Sheet'
---

# Tasks: Video Catalog Sheet

**Input**: `specs/022-video-catalog-sheet/` — [plan.md](plan.md), [spec.md](spec.md),
[research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/),
[quickstart.md](quickstart.md)

**Tests**: Included — the plan and quickstart name the test files, and the constitution requires
tests in `tests/`.

**Branch rule for every task**: this branch is cut from the released `cd0faa6`. Never modify
`packages/shared/src`, `packages/shared/package.json`, `apps/agent`, `packaging` or
`config/production.env` (research R1). UI uses the release's `components/ui.tsx` and
`components/Modal.tsx` — `components/ui/` and `styles/tokens.css` do not exist here (R10).

**Machine rule**: before any vitest/build, `uptime`; run with `nice -n 15`; vitest
`--pool=forks --poolOptions.forks.singleFork=true`; never `npm run verify`; never `supabase db reset`.

**Phase order**: US2 (settings) comes before US1 (create) — both P1, but a catalog cannot be created
without settings, so building settings first makes US1 testable end to end.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T001 Confirm the delivery gate is open on this branch: `git diff --name-only v1.1.1..HEAD -- apps/agent packaging packages/shared/src packages/shared/package.json config/production.env` prints nothing; read the release-state idioms the UI tasks copy — `apps/web/src/team/workspace/RestitchDefaultsSection.tsx`, `SettingsSection.tsx`, `TeamPreferencesSection.tsx`, `apps/web/src/team/library/VideoTextActions.tsx`, `apps/web/src/components/Modal.tsx`, `apps/web/src/team/errors.ts`

---

## Phase 2: Foundational (blocks every story)

### Schema

- [x] T002 Write `supabase/migrations/20260915010000_product_catalogs.sql` per data-model §1–4: replace `team_materials_companion_kind_check` with `('transcript','product_catalog')`; create `team_product_catalog_settings` and `team_product_catalogs` (columns, checks, index, RLS enabled + forced, `revoke all`); functions `get_team_product_catalog_settings` (view), `set_team_product_catalog_settings` (manage_metadata, raises `PERMISSION_DENIED` / `INVALID_INPUT`), `service_get_team_product_catalog_settings`, `get_material_product_catalog` (view, active companion only), `service_link_product_catalog_companion` (create/re-create/race semantics, clears links on every non-active `product_catalog` row of the video, inserts `team_catalog_events` for video and sheet); all `security definer`, `set search_path = ''`, grants to `authenticated` or `service_role` exactly as data-model lists
- [x] T003 Append the reverse steps for T002 to `supabase/migrations/ROLLBACK.md`
- [x] T004 [P] Write `tests/team-product-catalog-sql.test.ts` (PGlite harness `tests/support/team-db.ts`, style of `tests/team-companions-sql.test.ts`): settings readable by a viewer, writable only with `manage_metadata`, each check refuses (title 201 chars, price 0 / 1000000, image link `ftp://`); link on a non-video / non-spreadsheet returns `NOT_ELIGIBLE`; create links; second create returns `EXISTS` with `discarded` and leaves the new row trashed; re-create retires the old row and clears `companion_of` on all non-active catalog rows; stale `p_replaces` returns `EXISTS`; getter hides trashed sheets; a live transcript and a live catalog coexist on one video
- [x] T005 Apply T002 to the running beta with `npx supabase migration up --local`, then add the three client RPCs to `apps/web/src/lib/database.types.ts`, taking their shapes from `npx supabase gen types typescript --local --schema public` (not `npm run types:supabase`, which reads production). Done by hand, as 015 and 019 did: the committed file is curated and ~1600 lines away from a raw regeneration

### Pure core (Edge)

- [x] T006 [P] Write `supabase/functions/_shared/product-catalog.ts` (no imports) per data-model §5: limits, `parseProductCount`, `parseWebLink`, `formatPrice`, `videoShareLink`, `productCatalogName`, `PRODUCT_CATALOG_TEMPLATE` (31 columns, header strings byte-equal to `contracts/catalog-template.json`), `buildProductCatalogRows({ settings, sourceLink, videoLink, count })` returning typed cells (A and L numbers, everything else strings, `gtin` string, M = F, Z = videoLink + `?v=` + 3-digit row)
- [x] T007 [P] Write `tests/product-catalog-template.test.ts`: template equals `specs/022-video-catalog-sheet/contracts/catalog-template.json` (keys, descriptions, fixed values); count parser accepts `1`, `007`, `12`, `400`, refuses `0`, `401`, `-1`, `2.5`, `abc`, ``; link parser refuses `ftp://x`, `https://a b`; 400-row build: 402 rows, `A3=1`, `A402=400`, `Z3` ends `?v=001`, `Z402` ends `?v=400`, `F=M="10,00 USD"`; `productCatalogName('clip.final.mp4') === 'clip.final catalog'`; `videoShareLink` with and without resource key
- [x] T008 [P] Write `supabase/functions/_shared/xlsx.ts`: `buildXlsx({ sheetName, rows })` → `Uint8Array<ArrayBuffer>`; parts `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/worksheets/sheet1.xml`, `xl/sharedStrings.xml`, `xl/styles.xml`; shared strings de-duplicated and XML-escaped (including control characters); numeric cells without `t`; no `<f>`; stored ZIP entries with CRC-32 and a correct central directory
- [x] T009 [P] Write `tests/product-catalog-xlsx.test.ts`: read the output with `yauzl` — all parts present, CRCs valid, sheet name `catalog_products`, cell `A3` numeric, `AB3` shared string, a description `=HYPERLINK("x","y")` and `-dash` stored as shared strings, no `<f>` anywhere, `&<>"'` escaped, 400 rows with a 9999-char description under 1 MiB

### Drive helpers

- [x] T010 Add `createConvertedFile({ name, parentId, sourceMimeType, targetMimeType, bytes })` to `supabase/functions/_shared/drive.ts` — multipart upload (`uploadType=multipart`, `supportsAllDrives=true`, `fields=FILE_FIELDS`), parsed with `parseMetadata`, `INVALID_RESPONSE` on anything else, same 15 s timeout path as `#request`
- [x] T011 [P] Write `supabase/functions/_shared/link-sharing.ts`: `ensureAnyoneReader(drive, fileId)` → `{ added: boolean }` — list `anyone` permissions, add `reader` if missing, verify, `INVALID_RESPONSE` if verification fails

### Web data layer

- [x] T012 [P] Write `apps/web/src/team/product-catalog/limits.ts`: the same four limits and web-side validators (`validateProductCount`, `validateWebLink`, `validatePrice`, `validateTitle`, `validateDescription`) returning `{ ok: true, value } | { ok: false, reason }`, plus `formatPricePreview(price)`
- [x] T013 [P] Write `tests/product-catalog-parity.test.ts`: web limits and validators agree with `supabase/functions/_shared/product-catalog.ts` on the same table of inputs
- [x] T014 Add to `apps/web/src/api/team.ts`: types `ProductCatalogSummary`, `ProductCatalogSettings`, `ProductCatalogCreateResult`; methods `getProductCatalog`, `getProductCatalogSettings`, `setProductCatalogSettings` (RPCs, rows narrowed from `unknown`), `createProductCatalog` (via `invokeTeamFunction('drive-ops/product-catalog/create', …)`) per `contracts/product-catalog-api.md`

**Checkpoint**: T004, T007, T009, T013 green (single fork).

---

## Phase 3: User Story 2 — Set the space's catalog settings (P1)

**Goal**: A space manager saves Title, Description, Price (whole number) and Image link on a Catalog tab; members see them read-only.

**Independent test**: quickstart §4.

- [x] T015 [P] [US2] Add en and uk keys to `apps/web/src/i18n.ts` for the settings tab: tab label, section title and hint, four field labels, price preview (`{price},00 USD`), validation messages (whole number 1–999999, not a web link, too long, required), saved toast, read-only note
- [x] T016 [US2] Write `apps/web/src/team/product-catalog/ProductCatalogSettingsSection.tsx` inside `SettingsSection`, modelled on `RestitchDefaultsSection.tsx`: load via `getProductCatalogSettings`, fields with `field-label` + `input`/`textarea`, inline validation from `limits.ts`, price preview, Save via `setProductCatalogSettings`, read-only unless `useTeam().can('manage_metadata')`, errors through `teamErrorMessageFor`
- [x] T017 [US2] Add `'product-catalog'` to `TEAM_SETTINGS_TABS` in `apps/web/src/team/routes.ts` and render the section for that tab in `apps/web/src/team/workspace/SpaceSettings.tsx` (client type extended the way `RestitchDefaultsClient` is)
- [x] T018 [P] [US2] Write `tests/product-catalog-settings-section.test.tsx` (jsdom): read-only without `manage_metadata`; `10.5`, `0`, `USD 10`, `ftp://x` refused inline and not sent; valid save sends `{ title, description, price: 10, imageLink }` and shows `10,00 USD`
- [x] T019 [US2] Add the few layout rules the section needs to `apps/web/src/styles.css` using the file's existing custom properties (no new raw values)

**Checkpoint**: US2 works on beta (quickstart §4).

---

## Phase 4: User Story 1 — Create a catalog from a video (P1) 🎯 MVP

**Goal**: "Create catalog" on a video → link + count → shared native sheet next to the video, linked as its companion, link returned.

**Independent test**: quickstart §5.

- [x] T020 [US1] Write `supabase/functions/drive-ops/product-catalog.ts` `handleCreateProductCatalog(request, body, service, actorId)` following `contracts/product-catalog-api.md` "Order of work" steps 1–10: body parse from `unknown` (unknown fields refused), `loadContext` view + category check, `service_get_team_product_catalog_settings`, live catalog read, `proveContext`, `destinationWithClient` with `upload` on the video's parent, `ensureAnyoneReader` on the video behind `edit` + `canShare`, `buildUploadConflictPlan` (`keep_both`), `startSimpleOperation` kind `upload` + `bindIntent` (mime `application/vnd.google-apps.spreadsheet`, size null), `buildProductCatalogRows` + `buildXlsx`, `createConvertedFile`, `ensureAnyoneReader` on the sheet, `service_finalize_uploaded_material`, `service_link_product_catalog_companion`, Drive trash of `discarded` / `retired`, rollback on failure inside `withOperationFailure`; errors only from the existing vocabulary with `details.reason` / `details.field` (R14). Export the helpers it needs from `index.ts` or move them to `handler.ts` without changing their behaviour
- [x] T021 [US1] Route `path === '/product-catalog/create'` to `handleCreateProductCatalog` in `supabase/functions/drive-ops/index.ts`
- [x] T022 [P] [US1] Write `tests/product-catalog-handler.test.ts` with Drive `fetch` and RPCs mocked: refusal order (bad link → `INVALID_INPUT/link` before any Drive call; no settings → `WRONG_STATE/settings_missing`; not a video; `canShare=false` → `SHARE_NOT_ALLOWED` with no file created); happy path makes exactly one multipart create with the conversion mime and returns `outcome: created`; existing catalog → `outcome: existing` with no create; link `EXISTS` after create → new file trashed, `outcome: existing`; failure after create → file trashed and error returned; same idempotency key twice → one create
- [x] T023 [P] [US1] Add en and uk keys to `apps/web/src/i18n.ts` for the dialog and card: section title, Create catalog, link and count labels, count hint `1–400`, invalid messages, missing-settings notice + link text, progress, result (Copy link, Open, copied toast), error copy for `settings_missing`, `not_a_video`, `SHARE_NOT_ALLOWED`
- [x] T024 [US1] Write `apps/web/src/team/product-catalog/CreateProductCatalogDialog.tsx` with `components/Modal.tsx` and `Button` from `components/ui.tsx`: link input, count input (`inputMode="numeric"`, `maxLength=3`, default `100`), confirm disabled until both valid (`limits.ts`), missing-settings notice linking to the Catalog settings tab (from `getProductCatalogSettings`), one idempotency key per confirmation, busy state, result state with copy/open, `outcome: existing` shown as a result not an error; no sharing warning
- [x] T025 [US1] Write `apps/web/src/team/product-catalog/VideoProductCatalogActions.tsx` (create-only state for now) and render it under the transcript block for `row.category === 'video'` in `apps/web/src/team/explorer/PreviewPane.tsx`; disabled with the usual Drive explanation when the space's Drive is not usable
- [x] T026 [P] [US1] Write `tests/product-catalog-dialog.test.tsx` (jsdom): count `0`/`401`/`2.5`/empty and link `ftp://x` keep confirm disabled; missing settings shows the notice and no confirm; confirm calls `createProductCatalog` once even on double click; result shows the sheet link; `outcome: existing` renders the existing catalog
- [x] T027 [US1] Validate on beta per quickstart §3 and §5 (including §5.5 formula safety on real Drive and §5.6 400 rows); record anything Drive did differently in `specs/022-video-catalog-sheet/findings.md` — **Done on beta 2026-09-15** (real Drive): settings saved and refused `10.5`; a 3-product catalog in 9.5 s; CSV export signed out matches the contract; `=HYPERLINK(…)` stays text; sheet and video links open signed out. Two defects found and fixed (see findings.md). §5.6 (400 rows) not run on beta — covered by `product-catalog-xlsx.test.ts`

**Checkpoint**: MVP — a catalog can be created and its link used.

---

## Phase 5: User Story 3 — Find the catalog from the video (P1)

**Goal**: Anyone who can see the video opens or copies its catalog from the card and the row menu; updates arrive without reload.

**Independent test**: quickstart §6.1.

- [x] T028 [US3] Extend `apps/web/src/team/product-catalog/VideoProductCatalogActions.tsx`: fetch `getProductCatalog` on mount and on the explorer `revision`; when present show Copy link (primary) and Open; pass `revision` from `PreviewPane.tsx`
- [x] T029 [US3] Add Open catalog / Copy catalog link / Create catalog entries for video rows in `apps/web/src/team/explorer/RowActions.tsx` and `apps/web/src/team/catalog/MaterialRowMenu.tsx`, reusing the dialog from T024
- [x] T030 [P] [US3] Write `tests/product-catalog-actions.test.tsx` (jsdom): no catalog → Create; catalog → Copy link + Open with the sheet URL; a `revision` bump refetches and switches state
- [x] T031 [US3] Validate on beta per quickstart §6.1 with a second member — Done on beta for one member (card and row-menu entry). The second-member realtime refresh is covered by `product-catalog-dialog.test.tsx` (revision re-read), not by a second browser session

---

## Phase 6: User Story 4 — The catalog follows its video (P2)

**Goal**: rename/move/trash carry the catalog; copy does not.

**Independent test**: quickstart §6.2–6.6.

- [x] T032 [US4] Extend `apps/web/src/team/materials/tail.ts`: `MaterialTail.catalog`, read in `tailOf` via `teamApi.getProductCatalog` (never throws); `productCatalogNameFor(videoName)` = stem + ` catalog`; rename renames the catalog (`keep_both`), move moves it, trash trashes it, copy leaves it behind (comment why)
- [x] T033 [P] [US4] Extend `tests/team-material-tail.test.ts` with catalog cases: rename → `<new stem> catalog`, move → same destination, trash → both trashed, copy → only the video copied; a video with both transcript and catalog carries both
- [x] T034 [US4] Validate on beta per quickstart §6.2–6.6 — Done on beta: rename (sheet renamed to `<stem> catalog`), trash (sheet trashed with the video), restore (card shows the catalog again). Move and copy were not run on the real Drive — covered by `team-material-tail.test.ts`

---

## Phase 7: User Story 5 — Re-create a catalog (P3)

**Goal**: Replace a video's catalog with new link/count; one catalog remains, the old one in trash.

**Independent test**: quickstart §7.

- [x] T035 [US5] Add a re-create mode to `CreateProductCatalogDialog.tsx` (prefill link and count from `ProductCatalogSummary`, replacement notice, `replacesMaterialId`) and a Re-create entry in `VideoProductCatalogActions.tsx`, `RowActions.tsx` and `MaterialRowMenu.tsx`; add the en/uk keys to `apps/web/src/i18n.ts`
- [x] T036 [P] [US5] Extend `tests/product-catalog-dialog.test.tsx` (prefill, `replacesMaterialId` sent) and `tests/product-catalog-handler.test.ts` (re-create retires and trashes the previous file; stale `replacesMaterialId` → `outcome: existing`)
- [x] T037 [US5] Validate on beta per quickstart §7 (re-create, simultaneous create from two members, double click, Drive disconnected) — Done on beta: re-create from the row menu (name kept, previous sheet trashed, one live catalog). Simultaneous create and double click are covered by `team-product-catalog-sql.test.ts` and `product-catalog-handler.test.ts`; Drive-disconnected was not exercised

---

## Phase 8: Polish & delivery

- [x] T038 Run `npx prettier --write` on the changed files, `npx eslint` on them, and the web type check (`nice -n 15 npm run build -w apps/web` or the repo's check script) one at a time — Done: Prettier and ESLint clean on every changed file; `tsc -b apps/web` and `tsc -p tsconfig.check.json` (which type-checks the Edge modules through the tests) clean. The type check caught a wrong web type for the create result (`id` where the server sends `materialId`), fixed
- [x] T039 Run all focused tests from quickstart §1 once more, single fork, and re-run quickstart §2 (gate paths still untouched) — Done: the feature's 8 test files plus the 42 existing test files touching the changed components (50 files, single fork, in batches — one batch was killed for low memory and re-run). It caught a regression: `PreviewPane` rendered outside a `TeamProvider` threw; the catalog block now renders only inside a space. Gate paths unchanged since `cd0faa6`. The full suite is left to CI
- [x] T040 [P] Update `specs/022-video-catalog-sheet/findings.md` with what implementation learned (Drive conversion behaviour, any deviation from the plan) and mark completed tasks here
- [x] T041 Commit per phase with messages in the repo's style and push `022-video-catalog-sheet` — Committed per phase; pushed
- [ ] T042 **Owner-confirmed only** — rollout per quickstart §8: fast-forward `beta`, `release:backend-plan`, packaged beta verification of the exact SHA, `release:backend-apply`, `deploy:web`; then merge into `main`

---

## Dependencies

- Phase 1 → Phase 2 → stories.
- Inside Phase 2: T002 → T003, T004, T005; T006 → T007, T012/T013 parity; T008 → T009; T010 and T011 independent; T005 → T014.
- US2 (Phase 3) needs T005, T012, T014.
- US1 (Phase 4) needs T002–T014; testable end to end after US2.
- US3 needs US1 (a catalog to find). US4 needs T014 and T032 only, but its beta check needs US1. US5 needs US1 and US3.
- Polish after the stories that ship.

## Parallel opportunities

- Phase 2: T004, T006, T008, T011, T012 touch different files and can be written together; tests T007, T009, T013 follow their modules.
- US1: T022, T023 and T026 are separate files from T020/T024.
- On this machine, **writing** in parallel is fine; **running** tests or builds is strictly one at a time.

## Implementation strategy

1. Phases 1–2, then US2 → US1: this is the MVP (create a catalog and use its link).
2. US3 (find) and US4 (follow) — needed before the owner relies on it daily.
3. US5 (re-create).
4. Polish, commit, push; rollout only on the owner's go.
