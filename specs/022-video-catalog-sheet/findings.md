# 022 — Findings from the pre-spec analysis

Code-level facts gathered on 2026-09-15 while answering the owner's question "can this ship as a
web update, without a full release?". The spec stays free of implementation; this file is what
`/speckit-plan` should start from.

## Verdict: no desktop agent release is needed

- **Agent release trigger.** An agent release is forced only by a change to
  `WEB_TOOL_REQUIREMENTS` / `AGENT_TOOL_CONTRACTS` (`packages/shared/src/release.ts`): the map is
  byte-compared with the signed `stable.json`, so `deploy:web` refuses until an agent release
  publishes it. The catalog is not a local tool and needs no agent route or contract. **Do not add
  a key there.**
- **Companions are not agent code.** `grep companion apps/agent/src` finds nothing. The link lives
  in `team_materials.companion_of` / `companion_kind` (migration
  `20260830100000_media_companions.sql`); the server links a transcript in `drive-ops`
  (`service_link_transcript_companion`, ~`drive-ops/index.ts:1036`).
- **Follow-the-tail is web code.** Rename, move, copy and trash carry the companion through
  `apps/web/src/team/materials/tail.ts` (`copyMaterialWithTail`, `moveMaterialWithTail`,
  `renameMaterialWithTail`, `trashMaterialWithTail`). `MaterialTail` today holds only
  `transcript`; the catalog is a second field there, so it ships with the web update and works for
  every desktop version. This closes the open question from the analysis: there is no
  "before the next agent release" gap.
- **Compress-in-place keeps companions.** Overwrite-the-original uploads a new Drive version of the
  same material id (`drive-ops/index.ts:~1804`), so a catalog stays attached through it. Compress
  to a new file is a new material and, per FR-023, gets no catalog anyway.

## What already exists and can be reused

| Need                                                | Existing piece                                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-side Drive calls with the space's credential | `_shared/drive.ts` `GoogleDriveClient`, `readDriveCredential`, `refreshGoogleAccessToken`, `proveLiveAncestry`                                                              |
| Make a file viewable by link                        | `GoogleDriveClient.createAnyoneReaderPermission` / `listAnyonePermissions` (`drive.ts:400–440`)                                                                             |
| Share-a-video flow                                  | `library-ops` `shareMaterial` — the catalog takes its `allowIfRestricted` path directly, with no confirmation step (FR-004); keep the `canShare` and edit-permission checks |
| Copy-link UI                                        | `apps/web/src/team/library/CopyDriveLinkButton.tsx`                                                                                                                         |
| Per-space settings changed by managers              | `20260902150000_team_restitch_defaults.sql` — one row per space, write gated by `private.can(p_team, 'manage_metadata', …)`, RLS enabled and forced                         |
| One companion of a kind per video                   | unique index `team_materials_one_companion_idx` on `(team_id, companion_of, companion_kind)` — already kind-aware                                                           |
| Native Google file category                         | `packages/shared/src/team/material-category.ts:183` maps `application/vnd.google-apps.*` to `document`                                                                      |

## Constraints the plan must respect

- **Drive scope stays `drive.file`** (`_shared/scopes.ts`). Creating a native spreadsheet by
  uploading CSV/XLSX with conversion to `application/vnd.google-apps.spreadsheet`, and adding an
  `anyone`/`reader` permission on it, both work under `drive.file` because the app creates the file.
  A new scope (`spreadsheets`, or restricted `drive`) would force every space to reconnect and, for
  `drive`, Google verification — SC-007 forbids it. A template file kept in Drive by a person is not
  readable under `drive.file`, which is why the template lives in code.
- **Formula safety (FR-008).** With upload-conversion, a cell starting with `=`, `+`, `-` or `@` can
  be evaluated. The plan must choose a form that guarantees literal text (for example a leading
  apostrophe, or an XLSX with explicit string cells) and test it with a hostile value.
- **Widening `companion_kind`.** The check constraint `team_materials_companion_kind_check` allows
  only `'transcript'`. Widening it means `drop constraint … add constraint` in one migration. Check
  early whether `release:backend-plan`'s destructive-statement detector flags a dropped check
  constraint; the change itself is safe for released clients (it only admits more rows). Existing
  SQL functions all filter `companion_kind = 'transcript'`, so a catalog row will not be mistaken
  for a transcript — but every function that selects companions without that filter must be read.
- **Security (constitution III).** Space catalog settings follow the restitch-defaults pattern:
  readable by space members, written only through a `security definer` function that checks
  `manage_metadata`. The new server action authorises through
  `service_get_material_operation_context` with `edit` permission, as `shareMaterial` does.
- **UI primitives.** The branch is cut from the released commit, which predates 021: the dialog and
  settings use `components/Modal.tsx`, `components/ui.tsx` and the existing `field-label` idiom
  (research R10, R13).

## The template (owner's `11.xlsx`, read 2026-09-15)

- It is a Meta product-catalog feed exported from Google Sheets: one sheet `catalog_products`, 31
  columns A–AE, row 1 field descriptions (Russian/English mix, containing literal `|`), row 2 keys,
  products from row 3. The column mapping is in `contracts/catalog-template.md`; the exact strings
  are in `contracts/catalog-template.json`, extracted from the file rather than retyped.
- **The example file is not committed**; tests use a synthetic link.
- **Column Z link form.** The example uses `https://drive.google.com/file/d/<id>/view?usp=sharing`.
  Drive's `webViewLink` returns `…/view?usp=drivesdk`, and files with a resource key add
  `resourcekey=`. The plan must decide how to build the shared form from the file id (and keep a
  resource key when one exists) so the link opens for a signed-out viewer.
- **Size.** 400 products × 31 columns ≈ 12.4k cells plus headers — small for a single upload with
  conversion; no batching needed.
- **Cell types.** The example stores `id`, `quantity_to_sell_on_facebook` and `gtin` as numbers;
  the spec keeps the first two numeric and makes `gtin` text so Sheets never shows `8.80609E+12`.

## What the beta taught (2026-09-15, real Google Drive)

- **Drive sizes native spreadsheets.** `files.create` with conversion returns `size` for the new
  Google Sheet (the explorer already showed "Google-документ · 29.9 KB" for native files). Binding
  the upload intent with `expectedSize: null` before the upload made
  `service_finalize_uploaded_material` refuse the commit with `SOURCE_CHANGED`. The intent is now
  bound after the upload, from the metadata Drive returned (`drive-ops/product-catalog.ts`).
- **Re-creating kept a "(2)" suffix.** The retired sheet is trashed only after the new one is
  linked, so name planning saw it and suffixed the successor. The replaced sheet's Drive id is now
  excluded from the conflict candidates; the name reservation is unique among operations only,
  and Drive tolerates the brief duplicate.
- **Formula safety holds on real Drive (R2's verification debt closed).** A description
  `=HYPERLINK("https://example.com","x") …` exported back as CSV is the literal text, not `x`.
- **Links open signed out.** The sheet URL and the column-Z video URL (`…?usp=sharing?v=001`) both
  answer 200 with no sign-in redirect.
- **Timing.** A 3-product catalog: 9.5 s from confirm to the result on a loaded machine (load
  average above 20), inside SC-001's 15 s.
- **Settings layout.** `.settings-field-grid` turns each field group into a two-row subgrid (label,
  control), so a hint or an error under the price input was drawn over the input. The catalog
  settings use their own two-column grid.
- **The row menu cannot own a dialog** — it unmounts on close. "Catalog" in the menu asks the
  explorer shell to open `ProductCatalogMenuDialog`, the same arrangement the transcript prompt has.
- **Tail operations run after the primary one.** A rename's companion renames start only when the
  video's rename returns; closing the page within those seconds leaves the sheet unrenamed. This is
  the transcript's existing behaviour, not new to catalogs.

## Rollout path (no desktop release)

1. Additive migration(s): widen `companion_kind`, catalog metadata (pasted link, product count),
   space catalog settings.
2. Edge Function change (route `/product-catalog/create` in `drive-ops`, see plan.md). A change under
   `_shared` redeploys every function that imports it — `release:backend-plan` computes that.
3. `beta` branch contains the SHA → `beta:package` → `beta:verify` writes the promotion record for
   that exact SHA (required by `verify-beta-promotion.mjs`, chained into `deploy:web`).
4. `release:backend-apply`, then `npm run deploy:web`. `verify-published-release.mjs` checks the
   already-published agent artifacts; nothing new is published for the desktop.
