# Quickstart — Team Workspace That Works

Validation runs, not implementation. Every step names one command and one expected outcome.
**On the owner's machine: one command at a time; check `uptime` before anything heavy.**

## 0. Preconditions

- `npm run verify` green on the branch (fast form; ~1 min; do not run alongside a build).
- A Google OAuth **test** client for beta per `docs/BETA.md` § opt-in, now with scope
  `drive.file` in `supabase/functions/.env.local`, `DRIVE_OAUTH_MODE=testing`.
- A test Google account whose Drive holds the **reference root**: ≥ 500 files, ≥ 4 levels,
  ≥ 100 images, ≥ 50 videos, ≥ 10 landing archives, 1 folder with > 1,000 children, 1 shortcut
  to a folder outside the root, 1 provider-native document, 1 encrypted archive.
- A second Soty account (member) — the local stack returns invitation links, no email needed.

## 1. Spike R1 (before any storage code)

1. `npm run dev` (web + agent). Open the throwaway page `apps/web/spike/picker.html` (deleted
   after the spike).
2. Sign in, pick a nested folder with the Picker under `drive.file` (access token for the spike from the OAuth Playground or `gcloud auth print-access-token --scopes=https://www.googleapis.com/auth/drive.file`; nothing from US1 is needed).
3. Call the spike's "list children" and "list grandchildren" buttons (server credential).
4. Record A or B in `research.md` § R1 outcome with the raw counts. **Expected**: a
   definitive answer within one hour.

## 2. Beta run — storage and tree (US1, US4)

```bash
uptime && npm run beta:up
```

| Step | Expected |
| --- | --- |
| Create a space: name → Picker → pick the reference root | Space opens immediately; chip = "Indexing · N of ~M" |
| Watch the chip | Folders become openable while the count rises; chip reaches "Storage up to date" within 5 min |
| Expand every level in the tree; compare to Drive's own view | Same folders and counts at every level; breadcrumb clickable at every segment |
| Open the > 1,000-child folder | First screen < 1 s; total shown; scroll pages |
| Stop the beta stack's outbound network (or block `googleapis.com`); perform 100 folder openings across ≥ 20 distinct folders including the 5 largest (> 1,000 children) | ≥ 95 of 100 < 1 s from the index (SC-003); chip → "Waiting for Google Drive…" then back |
| Revoke the app in the Google account; act in the space — **three trials** | Each time: chip → "needs the owner to reconnect" within 1 min; rows still visible; one-click reconnect restores; no re-index of unchanged folders (SC-007: 3 of 3) |
| Rename the root in Drive; wait one reconciliation | Space follows; chip unchanged |
| Trash the root in Drive | Chip → "The connected folder was deleted"; "Restore from trash" works |
| Shortcut / native doc / encrypted archive rows | Each shows its kind and a one-line reason; none blank, none an error |
| Under R1 outcome B: add a second selection, remove it | Second top-level node appears/disappears; root removal refused |

## 3. Beta run — previews (US2)

| Step | Expected |
| --- | --- |
| After indexing, watch the chip | "Preparing previews · a of b" until b/b; no agent running |
| Scroll the images and videos folders | Every supported item has a thumbnail (100%) |
| Sign in as the member (no agent installed); same folders | Same thumbnails; image and video previews open |
| Open 20 images, 20 videos, 20 landings cold; time first useful frame | ≥ 57 of 60 within 2 s; landing shows screenshot first |
| Pair an agent at lowest power; leave 10 landings pending | Renders complete one at a time; `uptime` load stays under the compressor's ceiling; ordinary work not perceptibly slowed |
| Quit the agent mid-render; restart | Resumes the same row; nothing already ready is redone |
| Replace an image in Drive; wait one reconciliation | Old thumbnail never shown; new one prepared |

## 4. Beta run — explorer (US3)

| Step | Expected |
| --- | --- |
| Three first-time people, no hints: find a landing by name; list every video in a folder; move a creative; copy a share link | Each completes all four inside the explorer in < 3 min |
| `/landings`, `/library`, `/settings` deep links | Redirect to the explorer with the right filter / dialog |
| Every row of `contracts/explorer-ui.md` capability map | Reachable where the map says; `tests/team-explorer-capability-map.test.ts` green |
| Keyboard-only pass (tree, grid, preview, search, trash+undo) | Complete without a pointer |
| 320 px, 720 px, 1024 px widths | Drawer / sheet / three-pane; every action reachable |
| `npm run verify` (a11y, i18n, styles gates) | Green, no new baseline entries |

## 5. Beta run — the 010 uncovered list (US5), from both accounts

Rename, move, trash, restore, 50-result search page, background batch processing — each as
owner, observed by the member within 10 s without reload, then the reverse. Record in
`findings.md` (create) with environment, root, counts, outcome.

```bash
npm run beta:down
```

## 6. Production run

After the agent release that carries the render loop is published and the web deploy is
done: repeat §2 rows 1–4 and §3 rows 1–4 with the owner's own Google account and real root
on `https://soty.pp.ua`; consent screen must show "Soty" with no unverified warning
(SC-001). Return after 30 days: space opens without action (SC-002). Read
`npm run analytics -- team-workspace --period 30d --json` → `data.storage` shows
`index_completed ≥ 1`, `previews_ready ≥ 1`, `attention = 0`.

## 7. Gates

```bash
npm run verify            # every phase end
npm run verify:release    # before the beta run and before the PR
```
