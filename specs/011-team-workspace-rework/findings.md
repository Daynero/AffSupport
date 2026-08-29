# Findings — feature 011 (US5)

## Beta run, 2026-08-29 — partial (no Google account)

The beta stack came up on the development machine (colima → `supabase start` →
agent 43140 → web 5175). No OAuth test client or Picker key is configured yet
(T076), so everything that talks to Google — the chooser, the real folder tree,
provider thumbnails, reconciliation, token expiry — was **not** exercised. What
could be verified was verified against a real Postgres with all 53 migrations
and a synthetic connection seeded directly into the beta database: the folder
tree, paging, kind filters, the storage chip, the read-only state and the route
aliases.

The beta database was a persisted volume from an earlier session and was missing
the ten 011 migrations. They were applied forward-only, in order, each in its own
transaction — no reset, nothing dropped.

### Verified

| Check                                                           | Result                                                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Ten 011 migrations apply to an existing beta database           | Clean, 53/53; `preview-warm` cron scheduled                                               |
| `get_team_storage_health` refuses a caller with no `auth.uid()` | `PERMISSION_DENIED`                                                                       |
| `get_team_storage_health` as a member                           | `{"kind":"preparing","ready":2,"pending":4}` — matches the seeded rows exactly            |
| `list_team_folder_tree`                                         | All 4 folders in one call, with child folder/file and thumbnail-ready counts              |
| `list_team_folder_page`                                         | Folders first (`0                                                                         | banners`), `total`and`next` present |
| Explorer end to end                                             | Tree, breadcrumb, grid/list, kind filters, preview pane, trash and settings entries       |
| Storage chip                                                    | "Готуємо прев'ю · 2 з 6"; detail sheet offers check-now, pause previews, storage settings |
| Read-only attention state                                       | `needs_reauth` → rows stay visible, "Лише читання… нічого не втрачено", upload gone       |
| Route aliases                                                   | `/landings`, `/creatives`, `/settings`, `/trash` open inside the explorer                 |

### Fixed during the run

| #   | Defect                                                                                                                                                                  | Fix                                                                                                            | Regression test                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| B1  | Any non-`connected` state fell through to the space-state panel, so `needs_reauth` hid the whole explorer — an expired token read as data loss, defeating FR-033        | `WorkspaceShell.tsx`: browsable states are exactly the chip's attention states; the explorer renders read-only | `tests/workspace-shell.test.tsx` — "keeps the indexed catalog browsable, read-only" (confirmed failing without the fix) |
| B2  | `/landings` and `/creatives` kept folder scope, so an old bookmark opened on an empty screen — the kind lives further down the tree                                     | `routes.ts`: both aliases set `scope: 'space'`                                                                 | `tests/team-routes.test.ts` — alias scope assertions                                                                    |
| B3  | The always-visible storage chip was translucent over the honeycomb canvas; a bright cell made its text unreadable                                                       | `styles.css`: the chip paints an opaque surface, its tone over that                                            | Visual                                                                                                                  |
| B4  | Catalog search rows kept a max-content actions column built for the full-width page; inside the explorer's narrower column the name collapsed to one character per line | `styles.css`: the row answers to its container width (`container-type: inline-size`), stacking below 34rem     | Visual                                                                                                                  |
| B5  | The list row declared three grid columns for five children, so the size and the actions wrapped onto a second line and the name sat mid-row — it read as a broken table | `styles.css`: one column per child, the reason line still spanning                                             | Visual                                                                                                                  |
| B6  | A thumbnail that fails to load showed the browser's torn-page icon in the preview pane, while the tile already degraded to its kind glyph                               | `PreviewPane.tsx`: the same `onError` fallback as the tile, reset per row and version                          | Visual                                                                                                                  |

### Second beta pass, 2026-08-29 — driven by the owner's own walkthrough

| #   | Defect                                                                                                                                                                                              | Fix                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Disconnecting a folder was refused with "Google must approve this access": the OAuth gate wrapped every `drive-connect` action, including the one that gives a grant up                             | `drive-connect/handler.ts`: the gate covers only the actions that mint a grant (`start`, `reauth`, `confirm`, `replace`, `choose_root`) |
| C2  | Behind C1, a detach that had already succeeded came back as "the server responded unexpectedly": deleting the now-unusable credential threw, and the completed disconnect was reported as a failure | `drive-connect/index.ts`: credential cleanup is tidying-up, logged and swallowed; the detach's own result stands                        |
| C3  | Space settings were unreadable — two columns keyed to the **viewport** inside an 900px dialog, so headings broke mid-word and the invite address wrapped one letter per line                        | `SettingsDialog` is `xl`; the settings grid, invite form and role guide answer to their container                                       |
| C4  | The settings dialog's sticky header did not cover the dialog's own padding, so history rows scrolled visibly above the title                                                                        | `styles.css`: the bar spans the padding it sits in                                                                                      |
| C5  | Space history printed database identifiers — `drive.resynced`, `task.deleted`, `scanning`                                                                                                           | `TeamAuditPanel`: a sentence per action and per detail, in both languages                                                               |
| C6  | Every step into or out of a folder moved the whole grid: breadcrumb segments are buttons, and the global 44px control height made the toolbar taller whenever an ancestor was clickable             | `styles.css`: path segments are compact links on one scrolling line; measured jump is now 0px                                           |
| C7  | The tile's "Actions" button opened a menu nobody could see — the tile clipped it with `overflow: hidden`                                                                                            | `styles.css`: only the picture clips; menu items also left-aligned                                                                      |
| C8  | Tiles used platform emoji, floated an unstyled checkbox mid-tile, and put actions in the caption next to the file's name                                                                            | Drawn `KindIcon` set; selection and an `···` button overlay the picture on hover, focus or selection; folders get a compact tile        |
| C9  | The view switch sat between the toolbar's buttons                                                                                                                                                   | A segmented control at the end of the row                                                                                               |
| C10 | The task progress handle trailed the pointer by a frame: its position was written to a CSS variable from a post-paint effect                                                                        | `TaskProgressScale`: the position is an inline style on the element React renders                                                       |
| C11 | The same scale blended red→amber→green, so the boundary was nowhere near the handle                                                                                                                 | Two flat colours meeting exactly at the handle                                                                                          |
| C12 | "Indexing…" ran forever when the worker never picked the job up                                                                                                                                     | `20260829100000_team_storage_health_stall.sql`: a scan with no live job for 15 minutes reports `sync_failed` for a manager to retry     |
| C13 | A failed scan also made the space read-only, taking away writes the connection could still serve                                                                                                    | `WorkspaceShell`: only reasons that block a write do that                                                                               |
| C14 | Tasks lost their quick date ranges                                                                                                                                                                  | Today / Yesterday / This month / All time, beside the calendar                                                                          |
| C15 | Creating a task asked for a name in a dialog on the way to the editor that has the same fields                                                                                                      | The button makes the task and opens it; an untouched draft is removed when its editor closes                                            |
| C16 | A preview that failed said only "could not prepare"                                                                                                                                                 | The code's own sentence, through the shared error map                                                                                   |

Regression tests: C1 (`tests/drive-connect.test.ts`), C12 (`tests/team-storage-health-sql.test.ts`), C15
(`tests/creative-library-tasks.test.tsx`), C5 (`tests/team-members.test.tsx`). C2 lives in the
function's request wiring rather than its command layer and was verified against the running beta.

### Beta storage opt-in completed, 2026-08-29 (T076 partly)

A dedicated Google Cloud project `soty-beta` now carries the beta client, kept apart from
the live `wishlyproject` so its consent screen is untouched: OAuth client **Soty Beta Web**
(Web application, redirect `http://127.0.0.1:54321/functions/v1/drive-oauth-callback`), an
API key restricted to the Picker API, `drive.file` listed under **non-sensitive** scopes,
publishing status Testing with one test user, and both **Google Picker API** and **Google
Drive API** enabled — the Drive API was off, which would have failed every catalog call.
Values live in the two gitignored env files; `DRIVE_OAUTH_MODE=testing`.

Note for anyone repeating this: the containers bake their environment in at creation, so a
`docker restart` does not pick up an edited `.env.local` — `npm run beta:down && npm run beta:up`
does.

| #   | Defect found by doing it for real                                                                                                                                                                 | Fix                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| D1  | Returning from Google built `?settings=1?drive=connected` — a second `?`, so the code became part of the settings value, the panel never saw it, and the return landed on the create-space wizard | `TeamSpace.tsx`: joined with the separator the built route actually needs                  |
| D2  | The beta advisory said external storage was unavailable even after the opt-in, because the wizard asks before any status call and `undefined` always meant "unavailable"                          | `BetaStorageNotice.tsx`: the browser's chooser keys are the signal that the opt-in is done |
| D3  | The chooser opened on **Shared drives** only — one view with `setEnableDrives(true)` lists shared drives, never My Drive — so anyone without a Workspace shared drive saw "No folders."           | `loadPicker.ts`: two views, My Drive first                                                 |
| D4  | The chooser never took itself off the screen after a choice, so it sat over the page while the app worked, hiding whatever the app had to say                                                     | `loadPicker.ts`: dismissed on both picked and cancelled                                    |

Regression tests: D1 (`tests/space-settings.test.tsx`), D2 (`tests/beta-web-environment.test.tsx`).
D3 and D4 are chooser wiring, verified against the running chooser.

**Where this stopped.** The OAuth round trip, the chooser, both its tabs and the real folder
list are all working and were seen on screen. Confirming a folder is the one gesture the
automation could not complete — synthetic clicks on the chooser's own **Select** button
inside Google's iframe clear the selection instead of confirming it. Two human clicks
(a folder, then Select) finish it, after which the indexing, tree, thumbnails and preview
rows of §2–§3 can be checked.

### Still to run (needs the owner)

| Item                                                                      | Task  |
| ------------------------------------------------------------------------- | ----- |
| Beta OAuth test client with `drive.file`, `DRIVE_OAUTH_MODE=testing`      | T076  |
| `VITE_GOOGLE_PICKER_API_KEY`, `VITE_GOOGLE_PROJECT_NUMBER` in `.env.beta` | T076  |
| Reference root built per `quickstart.md` §0                               | T076  |
| Production Google Cloud project                                           | T076a |
| R1 spike (`quickstart.md` §1), outcome A/B                                | T002  |

With those in place: §2 (storage and tree, including the revoke-and-reconnect
trial and the root-trashed case), §3 (previews and the agent render loop), §4's
three-person and width matrix rows, and §5 (both accounts) remain.

### Noted, not ours

`tests/landing-preview-catalog.test.ts` ("renders multiple landings concurrently")
asserts a peak concurrency of `min(4, cpus)`. It failed once in the full suite while
the beta stack held four of the machine's eight cores, and passes alone. The file
belongs to the release stream (`2c209a2`), so it was left untouched; the assertion is
worth making load-tolerant once that stream is free.

## Production (after the next agent release, research R8)

Date: ____ · owner account: ____ · §6 result: ____
