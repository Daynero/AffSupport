# 022 — Quickstart: proving the product catalog works

A validation guide, not an implementation. Contracts: [`product-catalog-api.md`](contracts/product-catalog-api.md),
[`catalog-template.md`](contracts/catalog-template.md); data: [`data-model.md`](data-model.md).

## Machine discipline (this Mac)

One heavy process at a time. Before each step below that builds or tests: `uptime`, then
`nice -n 15`. Vitest always single-worker. **Never** `npm run verify` locally (CI runs it on the pull
request) and **never** `supabase db reset` against the running beta — it erases the beta's data.

## 1. Focused tests

```bash
nice -n 15 npx vitest run --pool=forks --poolOptions.forks.singleFork=true \
  tests/product-catalog-template.test.ts \
  tests/product-catalog-xlsx.test.ts \
  tests/product-catalog-parity.test.ts \
  tests/team-product-catalog-sql.test.ts \
  tests/team-material-tail.test.ts \
  tests/product-catalog-dialog.test.tsx \
  tests/product-catalog-settings-section.test.tsx
```

Expected: all pass. Among them, these must exist and be green:

- the embedded template equals `contracts/catalog-template.json` cell for cell;
- a 400-row build has `A3..A402 = 1..400`, `Z3 = …?v=001`, `Z402 = …?v=400`, `M = F = "10,00 USD"`;
- the XLSX read back with `yauzl` contains no `<f>` element, and a description `=HYPERLINK("x")`
  is a shared string;
- the web limits equal the Edge Function limits;
- SQL: settings writable only with `manage_metadata`; link refuses a second live catalog; re-create
  retires the old row and clears links on non-active rows; `get_material_product_catalog` hides
  trashed sheets;
- tail: rename renames the catalog to `<stem> catalog`, move moves it, trash trashes it, copy does
  not copy it.

## 2. The delivery gate stays open

```bash
git diff --name-only v1.1.1..HEAD -- apps/agent packaging packages/shared/src \
  packages/shared/package.json config/production.env
```

Expected: **no output**. Any path listed means `deploy:web` will refuse (`verify-release.mjs`), and
the feature would need an agent release (research R1).

## 3. Apply to the running beta

```bash
npx supabase migration up --local        # additive; never db reset
npm run beta:down && npm run beta:up     # reloads edge functions and the web build
```

Beta: web `http://127.0.0.1:5175` (Beta Tester), Supabase `http://127.0.0.1:54321`; edge logs
`docker logs supabase_edge_runtime_wishly`; DB
`docker exec supabase_db_wishly psql -U postgres -d postgres -c "…"`.

## 4. Settings (US2)

1. Space settings → **Catalog** tab. Enter Title, Description, Price `10`, Image link. Save.
   Expected: saved; the price field previews `10,00 USD`.
2. Try Price `10.5`, `0`, `USD 10`; Image link `not a link`. Expected: each refused inline, the
   saved values unchanged.
3. As a member without `manage_metadata`: the tab shows the values read-only.

## 5. Create (US1)

1. On a video with no catalog: **Create catalog**. Expected: dialog with link field and count `100`.
2. Count `0`, `401`, `-1`, `2.5`, `abc`, empty → confirm unavailable with the range explained. Link
   `ftp://x` → refused.
3. Paste a synthetic tracking link, count `3`, confirm. Expected within ~15 s: result with the sheet
   link, copy and open.
4. Open the sheet link in a signed-out browser window. Expected:
   - tab `catalog_products`; row 1 descriptions and row 2 keys as in the contract;
   - rows 3–5: `id` 1, 2, 3; title/description/image from settings; `price` and `sale_price`
     `10,00 USD`; `link` is the pasted link; `gtin` shown in full;
   - `video[0].url` ends `?v=001`, `?v=002`, `?v=003`; opening one plays the video signed out.
5. **Formula safety**: set Description to `=HYPERLINK("https://example.com","x")`, create another
   catalog on a second video. Expected: the cell shows the literal text, not a link.
6. **400 rows**: count `400` on a third video. Expected: finishes within the SC-001 wait, 402 rows.

## 6. Find and follow (US3, US4)

1. Second browser profile, another member: the same video's card shows **Copy link** with **Open**
   and **Re-create** in its menu, without reloading.
2. Rename the video → sheet renamed `<new stem> catalog`. Move it → sheet in the same folder.
3. Copy the video → the copy offers **Create catalog**; no second sheet appears.
4. Trash the video → the sheet is in the trash too; restore both → the card shows the catalog again.
5. Trash the sheet directly → the video offers **Create catalog**.
6. Delete the sheet in Google Drive itself → after the next catalog scan the video offers **Create
   catalog**.

## 7. Re-create and races (US5, edge cases)

1. **Re-create** → dialog prefilled with the previous link and count; change count to `5`, confirm.
   Expected: one catalog with 5 products; the previous sheet in Drive's trash.
2. Two members confirm **Create catalog** on the same video at the same moment. Expected: one sheet
   remains; the slower member's dialog shows the existing catalog, no error.
3. Double-click confirm. Expected: one sheet.
4. With the space's Drive disconnected: the action is disabled with the usual Drive explanation.

## 8. Web-only rollout rehearsal

Follow [`findings.md`](findings.md) → "Rollout path": backend plan (migration + `drive-ops`,
plus every function importing a changed `_shared` file), exact-SHA packaged beta verification,
`release:backend-apply`, `deploy:web`. Expected: `verify-release.mjs` prints "Web-only commit … is
compatible with Agent release v1.1.1", and no desktop artifact is built or published.
