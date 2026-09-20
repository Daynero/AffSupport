# 022 — Data model

All schema changes are in **one additive migration**,
`supabase/migrations/<timestamp>_product_catalogs.sql`, with its reverse steps added to
`supabase/migrations/ROLLBACK.md`. Security follows constitution III and the
`team_restitch_defaults` precedent: RLS enabled **and forced**, `revoke all` on tables and
functions, client access only through `security definer` functions with `set search_path = ''` that
derive the caller from `auth.uid()` and re-check permission with `private.can`.

Error strings raised by SQL are existing `TeamErrorCode` values only (`PERMISSION_DENIED`,
`INVALID_INPUT`, `NOT_FOUND`) — see research R14.

## 1. `team_materials` — widened companion kind

| Change                                | Before                             | After                                                 |
| ------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| `team_materials_companion_kind_check` | `companion_kind in ('transcript')` | `companion_kind in ('transcript', 'product_catalog')` |

- The pairing rule stays: `companion_of` and `companion_kind` are both null or both set.
- `team_materials_one_companion_idx (team_id, companion_of, companion_kind) where companion_of is
not null and lifecycle = 'active'` already allows one live catalog **and** one live transcript per
  video; unchanged.
- The sheet's own row: `kind = 'file'`, `category = 'other'`,
  `mime_type = 'application/vnd.google-apps.spreadsheet'`, `file_extension = null`.

## 2. `team_product_catalog_settings` — one per space

| Column        | Type          | Rule                                                |
| ------------- | ------------- | --------------------------------------------------- |
| `team_id`     | `uuid` PK     | → `teams(id)` on delete cascade                     |
| `title`       | `text`        | not null; `char_length` 1–200 after trim            |
| `description` | `text`        | not null; `char_length` 1–9999 after trim           |
| `price`       | `integer`     | not null; 1–999999                                  |
| `image_link`  | `text`        | not null; `^https?://[^\s]+$`, `char_length` ≤ 2048 |
| `updated_by`  | `uuid`        | → `auth.users(id)` on delete set null               |
| `created_at`  | `timestamptz` | default `now()`                                     |
| `updated_at`  | `timestamptz` | default `now()`                                     |

No row = not configured. All four fields are required together (a partial save is refused), so
"configured" is simply "a row exists" (FR-003).

**Functions**

| Function                                                           | Caller                             | Returns / raises                                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `get_team_product_catalog_settings(p_team uuid)`                   | `authenticated`, `view`            | the row or no rows; `PERMISSION_DENIED` (42501)                                                                              |
| `set_team_product_catalog_settings(p_team uuid, p_settings jsonb)` | `authenticated`, `manage_metadata` | the saved row; `PERMISSION_DENIED` (42501), `INVALID_INPUT` (22023) — the web validates each field first and shows it inline |
| `service_get_team_product_catalog_settings(p_team uuid)`           | `service_role` only                | the row or null                                                                                                              |

`p_settings` keys: `title`, `description`, `price` (JSON integer), `imageLink`. Unknown keys refused.

## 3. `team_product_catalogs` — one per catalog sheet

| Column              | Type          | Rule                                                                   |
| ------------------- | ------------- | ---------------------------------------------------------------------- |
| `material_id`       | `uuid` PK     | → `team_materials(id)` on delete cascade — the sheet                   |
| `team_id`           | `uuid`        | not null → `teams(id)` on delete cascade                               |
| `video_material_id` | `uuid`        | → `team_materials(id)` on delete set null — the video it was made from |
| `source_link`       | `text`        | not null; `^https?://[^\s]+$`, ≤ 8192 (tracking links are long)        |
| `product_count`     | `smallint`    | not null; 1–400                                                        |
| `sheet_url`         | `text`        | not null; `^https://`                                                  |
| `video_link`        | `text`        | not null; the shared link column Z was built from (without `?v=`)      |
| `settings_snapshot` | `jsonb`       | not null; `{ title, description, price, imageLink }` as used           |
| `created_by`        | `uuid`        | → `auth.users(id)` on delete set null                                  |
| `created_at`        | `timestamptz` | default `now()`                                                        |

Index: `(team_id, video_material_id)`.

The live catalog of a video is **not** stored here — it is the active `team_materials` row with
`companion_of = video and companion_kind = 'product_catalog'`. This table only describes a sheet;
retired sheets keep their row (useful history, removed with the material on hard delete).

**Functions**

| Function                                                                                                               | Caller                  | Returns                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_material_product_catalog(p_team uuid, p_video uuid)`                                                              | `authenticated`, `view` | zero or one row: `id`, `name`, `drive_file_id`, `sheet_url`, `source_link`, `product_count`, `created_at` — only for an **active** companion                                                               |
| `service_link_product_catalog_companion(p_team uuid, p_video uuid, p_companion uuid, p_replaces uuid, p_record jsonb)` | `service_role` only     | `{ linked: true, retired: [{materialId, driveFileId, resourceKey}] }` or `{ linked: false, reason: 'EXISTS' \| 'NOT_ELIGIBLE', existing: {…} \| null, discarded: {materialId, driveFileId, resourceKey} }` |

`p_record` keys: `sourceLink`, `productCount`, `sheetUrl`, `videoLink`, `settingsSnapshot`,
`createdBy`.

## 4. State of a video's catalog

```text
            create (no live catalog)                 re-create (p_replaces = live id)
 [none] ───────────────────────────────▶ [live] ───────────────────────────────────────▶ [live′]
   ▲                                       │  │                                             │
   │   trash sheet / trash video /         │  │ rename video → sheet renamed               │
   │   sheet gone in Drive (sync)          │  │ move video   → sheet moved                  │
   └───────────────────────────────────────┘  └─ copy video  → copy starts at [none]        │
                                                                                            │
 previous [live] on re-create ──▶ [retired]: lifecycle = trashed, companion_of/kind cleared ◀┘
 losing concurrent create     ──▶ [discarded]: lifecycle = trashed, never linked
```

- `[none]` is "no active companion row", whatever history exists.
- Trashing a live sheet directly leaves its `companion_of` set (no trash path clears links today —
  only the link functions do). So restoring it while the video still has no other catalog brings it
  back **linked**, which is the expected undo.
- Linking a new catalog clears `companion_of`/`companion_kind` on **every** non-active
  `product_catalog` row of that video, not only the one it replaces. A sheet restored after that
  comes back unlinked instead of colliding with `team_materials_one_companion_idx`. (The transcript
  link function clears only the active row it retires; the catalog closes that gap for itself and
  does not change the transcript's function.)

## 5. Pure model (Edge Function, no schema)

`supabase/functions/_shared/product-catalog.ts` — no imports; the web mirrors the four limits in
`apps/web/src/team/product-catalog/limits.ts` and `tests/product-catalog-parity.test.ts` asserts
equality.

| Export                                                  | Meaning                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `PRODUCT_COUNT_MIN = 1`, `_MAX = 400`, `_DEFAULT = 100` | dialog count                                                                                            |
| `PRICE_MIN = 1`, `PRICE_MAX = 999999`                   | settings price                                                                                          |
| `parseProductCount(unknown)`                            | `{ ok: true, value } \| { ok: false, error: 'count' }` — digits only after trim, leading zeros allowed  |
| `parseWebLink(unknown, max)`                            | `{ ok, value } \| { ok: false, error: 'link' }` — `URL` parse, protocol `http:`/`https:`, no whitespace |
| `formatPrice(price)`                                    | `` `${price},00 USD` ``                                                                                 |
| `videoShareLink(fileId, resourceKey)`                   | `https://drive.google.com/file/d/<id>/view?usp=sharing[&resourcekey=<key>]`                             |
| `productCatalogName(videoName)`                         | stem + ` catalog`                                                                                       |
| `PRODUCT_CATALOG_TEMPLATE`                              | the contract; a test keeps it equal to `contracts/catalog-template.json`                                |
| `buildProductCatalogRows(input)`                        | `Cell[][]` — two header rows + `count` product rows; `Cell = { t: 'string', v } \| { t: 'number', v }`  |

`supabase/functions/_shared/xlsx.ts` — `buildXlsx({ sheetName, rows: Cell[][] }): Uint8Array`
(stored ZIP, shared strings, CRC-32).
