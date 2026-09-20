# 022 — Research (Phase 0)

Every decision below was checked against the code on 2026-09-15. [`findings.md`](findings.md) holds
the pre-spec analysis; this file resolves what the plan needed on top of it.

## R0. Naming: "product catalog" in code

- **Decision**: The owner's "каталог" is called **product catalog** in code, schema and routes
  (`product_catalog`, `team_product_catalog_settings`, `team/product-catalog/`); user-facing text
  stays "Catalog" / "Каталог".
- **Rationale**: "catalog" already means the space's materials index here — `team/catalog/`,
  `team_catalog_events`, `catalog-sync`, `catalog-search`. Reusing the bare word would make every
  grep ambiguous and invite a `team_catalog_*` name that reads as part of that index.

## R1. The delivery gate forbids touching `packages/shared/src`

- **Decision**: No file under `packages/shared/src` (or `packages/shared/package.json`, `apps/agent`,
  `packaging`, `config/production.env`) changes in this feature. The catalog's pure logic lives in
  `supabase/functions/_shared/product-catalog.ts`, a module with no imports; the web keeps its own
  copy of the four input limits in `apps/web/src/team/product-catalog/limits.ts`, and a test proves
  the two agree.
- **Rationale**: `scripts/verify-release.mjs:385–402` refuses a web deployment whose diff from the
  release tag touches any of those paths ("web deployment includes Agent/shared changes not present
  in v1.1.1"). Today `git diff --name-only v1.1.1..HEAD` over them is empty on the branch's base `cd0faa6`, so the feature can ship web-only exactly as long as it keeps them
  empty. The constitution's own rule says the same ("A web-only deploy MUST NOT contain un-released
  agent/shared changes").
- **Alternatives considered**: Putting the template in `@video-compressor/shared` like other team
  contracts (Principle I's default home) — rejected because it would force an agent release, the
  one thing the owner asked to avoid. Editing only `packages/shared/dist` — rejected: `dist` is
  built from `src`, and a hand edit would be undone by the next build.
- **Parity pattern**: the repo already proves two copies agree instead of sharing one
  (`material-category.ts` ↔ SQL `team_material_kind`, `tests/team-material-kind.test.ts`).

## R2. How the spreadsheet is produced

- **Decision**: The Edge Function builds a minimal **XLSX** in memory (one worksheet
  `catalog_products`, a shared-strings table, stored — uncompressed — ZIP entries with CRC-32) and
  creates the file with a single Drive **multipart upload** whose metadata asks for
  `mimeType: application/vnd.google-apps.spreadsheet`, so Drive converts it into a native Google
  spreadsheet in the video's folder.
- **Rationale**:
  - Works under the existing `drive.file` scope (the app creates the file) — no new scope, no
    reconnect, no Google verification (FR-029, SC-007).
  - Cell types are explicit in XLSX: strings are shared-string cells (`t="s"`), numbers are
    numeric cells, and there is no `<f>` element anywhere, so a value starting with `=`, `+`, `-`
    or `@` is text and cannot be evaluated (FR-008). `gtin` is written as a string cell so it is
    never shown as `8.80609E+12`.
  - Shared strings de-duplicate the repeated title, description, link and headers, so even 400 rows
    with a 9999-character description stay far below Drive's import limits and the function's
    memory; stored entries avoid any compression dependency.
  - One Drive call creates and fills the sheet, so "created but half-filled" cannot happen (FR-011).
- **Alternatives considered**:
  - CSV with conversion — rejected: Sheets parses CSV cells, so `-Lightweight…` becomes a formula
    error and `10,00 USD` / long digit strings get re-typed.
  - Sheets API (`values.update`, `valueInputOption=RAW`) — the cleanest typing, and `drive.file`
    permits it, but the Sheets API must be enabled in the Google Cloud project for beta and
    production: a new operational dependency that `verify:production-config` does not check today.
    Rejected for v1.
  - Copying a template spreadsheet kept in Drive — rejected: `drive.file` cannot read a file the app
    did not create.
- **Verification debt**: that conversion keeps an `=`-leading shared string as text is standard
  XLSX semantics, but it is proven only against real Drive — quickstart step 5 does it on beta with a
  hostile description.
- **Dependencies**: none added. Edge Functions import only `npm:@supabase/supabase-js@2` today;
  the ZIP writer and CRC-32 table are ~80 lines of our own code, tested by reading the result back
  with `yauzl` (already in `node_modules`) in vitest.

## R3. Where the server action lives

- **Decision**: A new route `POST /drive-ops/product-catalog/create` in `supabase/functions/drive-ops`,
  handled by `handleCreateProductCatalog` in a new file `drive-ops/product-catalog.ts`.
- **Rationale**: `drive-ops` already owns everything this needs — team operations with idempotency
  keys (`startSimpleOperation`), destination proving with the `upload` permission
  (`destinationWithClient`), name conflict planning (`buildUploadConflictPlan` with `keep_both`),
  and material registration (`service_finalize_uploaded_material`). `handleCopy`
  (`drive-ops/index.ts:1367`) is the template: prove source, prove destination, reserve name, bind
  intent, Drive call, finalize. A separate file keeps `index.ts` (2381 lines) from growing.
- **Alternatives considered**: `library-ops` (holds `shareMaterial`) — rejected: it has no
  operation/finalize machinery. A new Edge Function — rejected: a new function is a new deployment
  and a new entry in `supabase/config.toml` and the production-config registry for no gain.

## R4. Registering the sheet as a material

- **Decision**: Reuse the upload operation. Intent is bound with
  `mimeType = 'application/vnd.google-apps.spreadsheet'`, `expectedName = planned name`,
  `expectedSize = null`; after the Drive call, `service_finalize_uploaded_material` commits the row
  from `driveResult(metadata)`.
- **Rationale**: Checked against the latest definition
  (`20260830180000_finalize_overwrite_support.sql:134–141`): it compares name, mime, parent and size
  with the intent (a native Google file has no `size`, so `null = null`), and requires a category in
  `('video','image','archive','transcript','landing','other')`. `classifyMaterial` gives a native
  spreadsheet `other`; the explorer still shows it as a document because `materialKindOf` maps the
  `application/vnd.google-apps.*` mime to `document` (`material-category.ts:183`). A retried request
  with the same idempotency key returns the committed operation (`authority.reused`), which is FR-012.

## R5. Linking, races and re-creation

- **Decision**: A new `service_link_product_catalog_companion(p_team, p_video, p_companion, p_replaces,
p_record jsonb)` (service role only), modelled on `service_link_transcript_companion`
  (`20260902090000_retired_companion_leaves_drive.sql`):
  - Locks the video row; requires `category = 'video'` and the companion's mime to be a native
    spreadsheet.
  - **Create** (`p_replaces is null`) while an active catalog already exists → does not link; marks
    the just-committed sheet row trashed and returns `{ linked: false, existing, discarded }`. The
    function then trashes the discarded file in Drive and answers with the existing catalog — the
    "two teammates at once" edge case.
  - **Re-create** (`p_replaces = current catalog id`) → retires that row (trashed, `companion_of` and
    `companion_kind` cleared) and returns it in `retired`; the function trashes the file in Drive
    via the existing `trashRetiredCompanions`. A stale `p_replaces` (someone re-created first) is
    treated like the create conflict.
  - Writes the catalog record (R8) and `team_catalog_events` for both rows, which drive realtime.
- **Rationale**: Same shape the transcript already proved; clearing `companion_of` on retired rows
  keeps a later restore-from-trash from colliding with the unique index
  `team_materials_one_companion_idx (team_id, companion_of, companion_kind) where active`, which is
  already kind-aware and needs no change.
- **Failure/rollback (FR-011)**: every step after the Drive create runs inside the handler's
  `withOperationFailure`; on any throw after the file exists, the handler trashes the file (and the
  row, if committed) before rethrowing.

## R6. Widening `companion_kind`

- **Decision**: The migration replaces `team_materials_companion_kind_check` with
  `companion_kind in ('transcript', 'product_catalog')`, as `alter table … drop constraint if exists …;
alter table … add constraint …` in one transaction.
- **Rationale**: Only admits more rows, so released clients are unaffected. The backend plan's
  destructive-statement scan flags `drop function|table|view|trigger|type` at statement start and
  `drop column` (`scripts/lib/release/migration-compat.mjs:53–57, 91`) — a dropped check constraint
  is not among them. Every existing SQL function that reads companions filters
  `companion_kind = 'transcript'` (the only migration file mentioning `companion_of` without that
  filter is `ROLLBACK.md`), so a catalog row is never mistaken for a transcript.

## R7. The video's shareable link and column Z

- **Decision**: If the video has no `anyone`/`reader` permission, the handler requires the `edit`
  permission on the video and Drive's `canShare`, then adds the permission — the checks
  `shareMaterial` in `library-ops` makes, without its confirmation round-trip (FR-004). The link is
  built from the file id: `https://drive.google.com/file/d/<id>/view?usp=sharing`, plus
  `&resourcekey=<key>` when the file has one; column Z appends `?v=` + the row number padded to three
  digits.
- **Rationale**: `webViewLink` comes back as `…/view?usp=drivesdk`; the owner's example uses
  `usp=sharing`, and the resource key is what lets a signed-out viewer open older files. The share
  step reuses `GoogleDriveClient.listAnyonePermissions` / `createAnyoneReaderPermission`
  (`_shared/drive.ts:400–440`); a small `ensureAnyoneReader` helper in `_shared/link-sharing.ts`
  holds the verify-after-create loop so `drive-ops` does not copy it from `library-ops`.
- **Refusal**: `canShare = false` → `SHARE_NOT_ALLOWED`; missing `edit` → `PERMISSION_DENIED`; both
  before any file is created.

## R8. Storage for settings and for the catalog record

- **Decision**:
  - `public.team_product_catalog_settings` — one row per space, the shape of `team_restitch_defaults`
    (`20260902150000_team_restitch_defaults.sql`): RLS enabled and forced, direct writes revoked,
    `get_team_product_catalog_settings(p_team)` for `view`, `set_team_product_catalog_settings(p_team, p_settings)`
    for `manage_metadata`, both `security definer` with `search_path = ''`.
  - `public.team_product_catalogs` — one row per catalog material: the video it was made from, the
    pasted link, product count, sheet URL and a snapshot of the settings used. Read through
    `get_material_product_catalog(p_team, p_video)` (`view`).
- **Rationale**: Keeps `team_materials` from growing catalog-only columns, gives re-create its
  prefill (FR-026) and the snapshot FR-016 asks for. Details in [`data-model.md`](data-model.md).
- **Alternatives considered**: Columns on `team_materials` — rejected (wide table, every material
  pays for a rare feature). Settings in `profiles` — superseded by the owner's decision that they are
  per space.

## R9. Following the video (web)

- **Decision**: `apps/web/src/team/materials/tail.ts` gains a `catalog` member on `MaterialTail`,
  read through `teamApi.getProductCatalog`. Rename renames it to `productCatalogNameFor(newName)`; move
  moves it; trash trashes it silently; copy deliberately does not copy it.
- **Rationale**: The tail module is the single place every surface already routes through (drag,
  cut-paste, row menu, trash). The spec was corrected during planning: the current trash tail asks
  nothing (`trashMaterialWithTail`: "No question asked"), so the catalog follows that, not the
  question 012 originally had.

## R10. Where it shows in the UI

- **Decision**:
  - Video card (`team/explorer/PreviewPane.tsx`): a "Catalog" block under the transcript block —
    `VideoProductCatalogActions` shows "Create catalog", or "Copy link" as primary with "Open" and
    "Re-create" beside it, built like `team/library/VideoTextActions.tsx`.
  - Row menu (`team/catalog/MaterialRowMenu.tsx` / `team/explorer/RowActions.tsx`): the same actions
    for video rows.
  - Dialog `CreateProductCatalogDialog` (`team/product-catalog/`): `Modal` from
    `components/Modal.tsx`, `Button` from `components/ui.tsx`, fields as the release's settings do
    (`<label className="field-label">` + `<input>`, `TeamPreferencesSection.tsx:70–100`), the
    missing-settings notice and the result state inside the same modal.
  - Space settings: new tab `product-catalog` in `TEAM_SETTINGS_TABS` (`team/routes.ts`) rendering
    `ProductCatalogSettingsSection` inside `SettingsSection`, modelled on `RestitchDefaultsSection`
    (read-only unless `can('manage_metadata')`).
- **Rationale**: The branch is cut from the released commit (R13), where the 021 component
  inventory (`components/ui/`, `styles/tokens.css`) does not exist. The feature uses the vocabulary
  the released web already speaks; when 021 merges, its migration covers these files like every
  other pre-021 screen.

## R11. Realtime

- **Decision**: No new channel. The link function inserts `team_catalog_events` (`upserted`) for the
  video and the sheet, which already bumps the explorer's `revision`; `VideoProductCatalogActions` refetches
  on `revision`, as the transcript block does.

## R12. Analytics

- **Decision**: No new analytics event in v1.
- **Rationale**: Event names are constrained in the database (`analytics_event_name_v2_check`,
  `20260720130000_analytics_v2.sql`) and mirrored in the analytics CLI; adding one is a migration
  plus CLI work unrelated to the owner's ask. Catalog creations are countable later from
  `team_product_catalogs.created_at`.

## R13. Branching: from the released commit, not from `main` or 021

- **Decision**: Implementation happens on `022-video-catalog-sheet`, cut from `cd0faa6`
  (`release: record 1.1.1 artifact digests` — the commit `origin/beta` and `origin/release/1.1.1`
  point at). It is deployed web-only from there, and merged into `main` afterwards.
- **Rationale**: The owner's post-release UI work (feature 021 and the `feat(ui)` commits already on
  `main`, 45 commits past `v1.1.1`) must not reach this web deployment. `cd0faa6` descends from
  `v1.1.1` with no agent/shared changes, so `verify-release.mjs` accepts a web-only commit on top
  of it, and the beta promotion gate needs this branch's SHA in `beta` — which fast-forwards from
  `cd0faa6` without dragging `main` along.
- **Consequence**: The 021 design-system files are absent here; see R10.

## R14. Error codes come from the existing vocabulary

- **Decision**: No new error code. The handler and SQL use existing `TeamErrorCode` values, with a
  stable `details.reason` where the web needs to tell cases apart: `INVALID_INPUT`
  (`details.field: 'link' | 'count'`), `WRONG_STATE` (`details.reason: 'settings_missing'` with
  `details.missing` as a comma-separated list, or `'not_a_video'`), `SHARE_NOT_ALLOWED`,
  `PERMISSION_DENIED`, `NOT_FOUND`, and the Drive family (`DRIVE_UNAVAILABLE`, `NEEDS_REAUTH`,
  `RATE_LIMITED`).
- **Rationale**: `TeamErrorCode` is defined in `packages/shared/src/team/transport.ts`; the Edge
  Functions' status map (`_shared/errors.ts`) and the web's copy map (`apps/web/src/team/errors.ts`)
  are total records over it. A new code is a shared change, which R1 rules out. `details` is already
  part of `TeamStructuredError` (`Record<string, string | number | boolean | null>`), so the reason
  travels without a contract change; constitution V's "stable machine code" is met by the pair.
