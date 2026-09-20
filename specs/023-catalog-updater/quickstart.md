# 023 — Quickstart: proving the catalog updater works

Validation guide. Contracts: [`updater-api.md`](contracts/updater-api.md); data:
[`data-model.md`](data-model.md); decisions: [`research.md`](research.md).

## Machine discipline

One heavy process at a time: `uptime` and `pgrep -fl "tsc|vitest|vite build"` first, `nice -n 15`,
vitest `--pool=forks --poolOptions.forks.singleFork=true`. Never `npm run verify` locally, never
`supabase db reset` on the running beta (`npx supabase migration up --local` only).

## D1

### 1. Focused tests

```bash
nice -n 15 npx vitest run --pool=forks --poolOptions.forks.singleFork=true \
  tests/catalog-updater-ids.test.ts tests/team-catalog-updater-sql.test.ts \
  tests/catalog-updater-worker.test.ts tests/catalog-updater-dialog.test.tsx \
  tests/catalog-updater-chip.test.tsx tests/team-product-catalog-sql.test.ts
```

Must cover: the ID rule for k = 0…2000 without repeats; a round opens once for an overdue updater;
leases (second claim gets nothing, expired lease re-claimable); complete/retry are lease-guarded;
`update_count` survives leaving and rejoining; registry hides catalogs whose sheet or video is gone;
`save` refuses empty lists, foreign catalogs, `restitch = true`, missing `process`; worker rebuilds rows
with shifted IDs and leaves every other cell as 022 wrote it; chip counts down from `nextRunAt` and
disappears when stopped; dialog selects all filtered rows.

### 2. Delivery gate

```bash
git diff --name-only v1.1.1..HEAD -- apps/agent packaging packages/shared/src \
  packages/shared/package.json config/production.env
```

Expected: nothing for D1.

### 3. In-place update on real Drive (before anything else on beta)

On the beta, pick a catalog created by 022; call the worker's update path once for it (a one-off
script or by pulling `next_run_at` forward, §5). Then check:

- the sheet's Drive id and URL are unchanged;
- it is still a native Google Sheet (CSV export works signed out);
- column A reads `501…` for a 100-product sheet, everything else as before.

If the id or type changes, stop and switch R4 to the Sheets API fallback.

### 4. Beta setup

```bash
npx supabase migration up --local
npm run beta:down && npm run beta:up    # reloads functions and web; writes worker vault URL/secret
```

Check the cron job exists and derives the right URL:

```bash
docker exec supabase_db_wishly psql -U postgres -d postgres -c \
  "select jobname, schedule from cron.job where jobname = 'wishly-catalog-updater'"
```

### 5. End to end without waiting an hour

1. Open the space → **Catalog updater** (header chip area is empty) → dialog opens.
2. Search a catalog, tick two, choose **1 hour**, **Start**. Close the dialog: the chip shows running,
   a countdown near 59:59, and "2 catalogs".
3. Pull the due time forward:
   ```bash
   docker exec supabase_db_wishly psql -U postgres -d postgres -c \
     "update public.team_catalog_updaters set next_run_at = now() where state = 'running'"
   ```
4. Within about a minute: both sheets (same links) show IDs `501…`; the chip counts down from ~1 h
   again; the dialog shows "last updated" for both.
5. Repeat step 3: IDs become `1002…`.
6. Break one catalog (trash its sheet in Drive): after the next round it leaves the updater and the
   dialog says so; the other catalog still updates.
7. **Stop**: the chip disappears; pulling `next_run_at` forward does nothing.

### 6. Reach

The hosted site shows the chip and dialog after `deploy:web`. The agent's local page (Safari) shows
them only after the next desktop release (022 lesson).

## D2 (with the desktop release)

1. In the dialog, turn on **Re-stitch video**, choose **this computer**. The dialog shows the computer
   as online.
2. Immediately a `<video stem> restitched 1.mp4` appears next to each video; the chip shows
   "ready 0/2" → "ready 2/2".
3. Pull `next_run_at` forward: sheets' column Z now opens the re-stitched copies (distinct per row);
   a second spare starts preparing; no more than two copies per video exist.
4. Next round: the previously used copy is permanently deleted (not in Drive trash).
5. Quit the desktop app: the dialog shows offline after ~2 minutes; the next round still rewrites IDs
   and keeps the current video link; the chip shows attention.
6. **Stop**: spares are deleted; each sheet keeps pointing at the copy in use.
