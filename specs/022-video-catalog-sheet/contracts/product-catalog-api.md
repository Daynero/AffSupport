# Contract — Product catalog API

Two surfaces: one Edge Function route (creates a sheet) and three client RPCs (read the video's
catalog, read and write space settings). Envelopes and error shape are the existing team transport
(`TeamEdgeResult`, `TeamStructuredError`); no new error code (research R14).

## `POST /functions/v1/drive-ops/product-catalog/create`

Called by `teamApi.createProductCatalog` through `invokeTeamFunction`. Authenticated user JWT.

### Request

```json
{
  "teamId": "uuid",
  "videoMaterialId": "uuid",
  "sourceLink": "https://…",
  "productCount": 100,
  "replacesMaterialId": null,
  "idempotencyKey": "catalog:<uuid>"
}
```

| Field                | Rule                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `teamId`             | UUID                                                                                      |
| `videoMaterialId`    | UUID of an active material with `category = 'video'`                                      |
| `sourceLink`         | `http`/`https` URL, no whitespace, ≤ 8192 chars                                           |
| `productCount`       | JSON integer 1–400                                                                        |
| `replacesMaterialId` | `null` to create; the current catalog's material id to re-create                          |
| `idempotencyKey`     | existing idempotency pattern `^[a-z0-9][a-z0-9._:-]{7,199}$`; one per dialog confirmation |

Unknown fields → `INVALID_INPUT`.

### Order of work (all refusals happen before anything is created)

1. Parse body; load the video context with `view`; refuse a non-video (`WRONG_STATE`,
   `reason: not_a_video`).
2. Read space settings (service); none → `WRONG_STATE`, `reason: settings_missing`.
3. Read the video's live catalog. Create while one exists, or re-create naming a different id →
   **success** with `outcome: "existing"` (no file is made).
4. Prove the video live in Drive and the destination (the video's parent folder) with `upload`.
5. If the video has no `anyone`/`reader` permission: require `edit` on the video
   (`PERMISSION_DENIED`) and `canShare` (`SHARE_NOT_ALLOWED`); add the permission and verify it.
6. Reserve the name `<video stem> catalog` (`keep_both`), start an `upload` operation with the
   idempotency key; a reused, succeeded operation returns its recorded result.
7. Build rows and XLSX; multipart-create the converted spreadsheet in the folder.
8. Add `anyone`/`reader` on the sheet and verify; read back its `webViewLink`.
9. `service_finalize_uploaded_material`, then `service_link_product_catalog_companion`.
   - `linked: false` (lost a race) → trash the new sheet in Drive; success with
     `outcome: "existing"`.
   - `retired` entries → trash those files in Drive (best-effort, logged).
10. Any failure after step 7 → trash the new file (and its row, if committed), mark the operation
    failed, return the error.

### Success `200`

```json
{
  "outcome": "created",
  "catalog": {
    "materialId": "uuid",
    "name": "clip catalog",
    "sheetUrl": "https://docs.google.com/spreadsheets/d/…",
    "sourceLink": "https://…",
    "productCount": 100
  },
  "videoShared": true
}
```

`outcome` is `"created"`, `"recreated"` or `"existing"` (the catalog shown is then the one that
already existed; the dialog shows it without an error). `videoShared` is `true` when step 5 added the
permission.

### Errors

| Code                                               | Status | When                                                                           |
| -------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `INVALID_INPUT` + `details.field: link \| count`   | 400    | body validation                                                                |
| `NOT_FOUND`                                        | 404    | video not in the space, trashed, or gone from Drive                            |
| `WRONG_STATE` + `details.reason: not_a_video`      | 409    | material is not a video                                                        |
| `WRONG_STATE` + `details.reason: settings_missing` | 409    | no settings row for the space                                                  |
| `PERMISSION_DENIED`                                | 403    | no `upload` on the folder, or no `edit` on a not-yet-shared video              |
| `SHARE_NOT_ALLOWED`                                | 403    | Drive reports `canShare = false` for the video or the new sheet                |
| `DRIVE_UNAVAILABLE` / `NEEDS_REAUTH`               | 503    | space's Drive connection unusable                                              |
| `RATE_LIMITED`                                     | 429    | Drive quota                                                                    |
| `INVALID_RESPONSE`                                 | 502    | Drive answered with something unparseable, or verification after create failed |

## RPC `get_material_product_catalog(p_team uuid, p_video uuid)`

`teamApi.getProductCatalog(teamId, videoId)` → `ProductCatalogSummary | null`

```ts
interface ProductCatalogSummary {
  id: string;
  name: string;
  sheetUrl: string;
  sourceLink: string;
  productCount: number;
  createdAt: string;
}
```

Requires `view`; returns nothing for a video without an active catalog.

## RPC `get_team_product_catalog_settings(p_team uuid)`

`teamApi.getProductCatalogSettings(teamId)` → `ProductCatalogSettings | null`

```ts
interface ProductCatalogSettings {
  title: string;
  description: string;
  price: number; // whole number 1–999999; shown in the sheet as `${price},00 USD`
  imageLink: string;
  updatedAt: string;
}
```

## RPC `set_team_product_catalog_settings(p_team uuid, p_settings jsonb)`

`teamApi.setProductCatalogSettings(teamId, input)` → `ProductCatalogSettings`

`input` = `{ title, description, price, imageLink }`, all required. Requires `manage_metadata`
(`PERMISSION_DENIED`); any rule from [`data-model.md`](../data-model.md) §2 broken → `INVALID_INPUT`.
The web validates each field with the limits in `apps/web/src/team/product-catalog/limits.ts` before
calling, so the RPC error is a backstop rather than the user's feedback.
