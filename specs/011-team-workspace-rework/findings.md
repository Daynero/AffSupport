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

### First real connection, 2026-08-29 — the space root could not be named

With a live Google account the whole connect path worked on the first try: consent,
callback, `choose_root`, the initial scan (`sync=ready`, phase moved to `incremental`),
and the chip settling on "Storage up to date". The picked folder was empty, so the next
thing to try was putting something in it — and nothing could be.

The connected root is deliberately **not a material**; catalog-sync says so in as many
words. Every file operation, though, identified its destination or its parent by material
id, so the one folder the explorer opens on could not be named. Uploading into the space
root, moving a file back to it, and renaming anything sitting directly in it were all
impossible — and 011 made the root the primary screen, so this went from an edge case to
the common one. It hid behind five separate layers, each of which had to be found by
provoking the next:

| Layer | What refused                                                                                                                                                                                                                        | Fix                                                                                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1    | The web upload never reached the server at all: the explorer inferred the root's id from the first top-level folder's parent, which an empty space does not have, and refused with "Google Drive is unavailable" — which it was not | `ExplorerShell.tsx`: no open folder means the root, and the server resolves it                                                                                                            |
| E2    | `validateUploadStartRequest` demanded a uuid, but the explorer navigates by provider ids                                                                                                                                            | `drive-ops/handler.ts`: a destination is a material id, a provider folder id, or absent                                                                                                   |
| E3    | `handleUploadStart` / `handleMove` / `handleRename` loaded the destination and the parent as materials; renaming a top-level file failed with `ROOT_ESCAPE`, which reads as a security refusal                                      | `drive-ops/index.ts`: one resolver that accepts all three forms, plus `service_get_root_operation_context` and a conflict lookup keyed by provider folder id (migration `20260829110000`) |
| E4    | `service_start_team_operation` refused a name reservation without a destination material                                                                                                                                            | migration `20260829120000`                                                                                                                                                                |
| E5    | `team_operations_reservation_check` said the same thing at the table level                                                                                                                                                          | same migration; the reservation index folds the root into one key with `coalesce`, so two people uploading the same name into the root still collide                                      |

After those, `uploads/start` for the root answers `202` with a live resumable session — the
server half of an upload works.

### Uploads reach Drive, 2026-08-29

The browser's PUT to the resumable session was refused by CORS: the session is opened
server-side with no `Origin`, so no tab can use it directly — in production as much as here.
The design already answered that with a relay, which turned out never to have been wired up,
and behind it two payload contracts that had never matched.

| #   | What refused                                                                                                                                                                                                                                          | Fix                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | The client PUT straight at the provider and ignored the `relayUrl` the start call returns                                                                                                                                                             | `resumableUpload` takes a `sendChunk`; the upload sends every chunk through the relay                                                                   |
| F2  | The relay's address was built from the request as the container sees it (`127.0.0.1:8081`)                                                                                                                                                            | the browser builds it from the public address, the way render ranges already do; the function still prefers forwarded headers when a gateway sends them |
| F3  | The relay took only `POST`, and refused a browser chunk for want of a `content-length` it is not allowed to set                                                                                                                                       | the check applies when the header is there; the bounded reader already holds the body to the declared range                                             |
| F4  | The relay and the finalize step both demanded a destination material, so a root upload died at the last step                                                                                                                                          | both resolve the destination the same way as the rest of the function                                                                                   |
| F5  | `service_finalize_uploaded_material` rejected `classificationVersion`, a key the Edge always sent and the function never accepted — so **no upload has ever been committed by finalize**; files appeared only when the next catalog scan noticed them | migration `20260829130000` also finalises into the root; the Edge sends what the command accepts                                                        |
| F6  | The same mismatch, larger: `service_commit_team_material_mutation` accepts seven keys and was sent fifteen, so **every rename and move failed** with "some of the data is wrong"                                                                      | a payload built for that command                                                                                                                        |

Verified on the beta stack: uploading a file through the app reports "1 file uploaded" and the
file appears in the space; `drive-ops/rename` answers `succeeded`.

## G — the connected space, exercised (2026-08-29)

The space is connected to a real Drive folder with 19 files, and every flow below was
run in the browser rather than reasoned about.

| ID  | What was wrong                                                                                                                                                                                                                                                                                            | Fix                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| G1  | Opening a file answered "Не вдалося підготувати перегляд." — `previewMaterial` returned the media grant with the gateway's internal address, the last caller not going through `browserFunctionUrl`                                                                                                       | translate it there too                                                              |
| G2  | A task saved from the editor vanished: `TaskEditor` reports the change and closes in one tick, so `closeEditor`'s render-time copy of the draft marker still said "untouched" and deleted it                                                                                                              | the marker is a ref; nothing renders from it                                        |
| G3  | The row menu painted "Перемістити в кошик" outside its own rounded panel — a fixed 240px against a 250px item                                                                                                                                                                                             | the panel takes the width its longest item needs, between a floor and a ceiling     |
| G4  | Attachment tiles carried four labelled buttons on a 158px tile, each breaking its word across two lines                                                                                                                                                                                                   | icon-only, label as the accessible name and tooltip, colour on hover                |
| G5  | Space history printed raw keys ("material.rename"): a finished transfer operation is recorded as `material.` plus its own kind, which the label map did not know                                                                                                                                          | both spellings mapped, plus the storage-selection events and the `connected` detail |
| G6  | **Landing renders never ran.** The job's two addresses are the ones the Agent must fetch from, and the function reports its internal hop — locally `http://127.0.0.1:8081/drive-transfer/range`, whose path lacks the `/functions/v1` prefix the Agent requires. Every job was refused with INVALID_INPUT | the browser rewrites both from its own Supabase URL                                 |
| G7  | Starting a render moves the row to "rendering" and nothing moved it back when the Agent refused it: no worker held it, the loop only picks up "stale", and the chip counted it as a preview still being prepared — for good                                                                               | the loop releases the row through the endpoint the Agent uses for its own failures  |
| G8  | A bare `.html` file is a landing by its own type, but rendering only ever unpacked a ZIP, so those files failed as "corrupt" every time                                                                                                                                                                   | a single page is written out as the one-entry package it stands for                 |

Verified live: image and transcript previews open; the download range answers `206` from
the public function URL; an uploaded `.mp4` arrives byte-identical (SHA-256 checked against
the local file) and gets a provider thumbnail; an uploaded landing reaches `ready` and its
rendered page appears on the tile and in the sandboxed viewer; trash and its Undo both
round-trip; the storage chip settles to "Сховище актуальне".

### Known gaps, recorded rather than fixed

- A ZIP holding `index.html` stays an **archive**. Promotion to a landing runs through
  `service_apply_landing_validation`, which the viewer only calls for a material that is
  already a landing — so a landing package dropped into Drive by hand is never promoted.
  Landings therefore arrive either as `.html` files or from Soty's own upload path.
- The nested-folder tree could not be exercised: the reference folder has no subfolders and
  the app has no "new folder" action, so §2's tree rows still need the reference root from
  `quickstart.md` §0.
- Video **playback** could not be confirmed in this browser: the bytes are provably correct
  (identical SHA-256, `206` with the right `content-range`), but this Chrome leaves the
  element at `readyState 0` even for a `blob:` URL of the same bytes. A decoder limitation
  of the automation profile, not of the transfer path.

## H — a second pass through the connected space (2026-08-29, evening)

Beta stack brought up from a cold machine (colima had not come back after the reboot; `beta:up`
names that and stops). Every screen was walked again in the browser at 1035, 1040, 720 and
360 px: tiles and list, all five preview kinds, search, rename, trash and its undo, upload
through the relay, tasks (create, save, filters, slider, attachments), members, settings,
history. Working as recorded in section G: previews (video plays in this profile), upload
(`start` → `relay` → `finalize`), trash → undo, task editor. What was not:

| ID  | What was wrong                                                                                                                                                                                                                                                                                          | Fix                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | Renaming from the row menu could not be done from the keyboard: the field opened unfocused, 93 px wide under the still-open item list; Enter went to the explorer's shortcut and opened a preview of whatever row was focused (and cancelled the submit); a space in the new name toggled the selection | `MaterialRowMenu`: the form replaces the item list, the field is focused with the base name selected, the menu keeps its own keys; `ExplorerShell` ignores keys typed in a field |
| H2  | `/` did nothing until the search it was meant to open was already on screen (the only listener lived in the search bar); "Search" opened the panel without focusing it                                                                                                                                  | the shell binds `/` while the search is closed; the bar focuses itself when the explorer opens it                                                                                |
| H3  | Trash, restore and move never appeared in the space history: `service_complete_material_group_intent` updated the rows and catalog events but wrote no audit row — only the rename/transfer commit did                                                                                                  | migration `20260829140000`: one `record_team_audit` call per completed intent, under the operation's actor                                                                       |
| H4  | Delete on a focused row did nothing (`contracts/explorer-ui.md`: Delete → trash with undo)                                                                                                                                                                                                              | `ExplorerShell`: Delete/Backspace trash the focused or checked rows with an Undo toast; the selection bar gets the same button                                                   |
| H5  | At a 1040 px viewport the list showed `be…`, `b…` or no name at all: the name column had no floor while kind and size kept theirs; tiles fell to one per row for the same reason                                                                                                                        | `styles.css`: the content column keeps 380 px before the tree and pane give way; list rows drop the kind, then the size, before the name (container queries)                     |
| H6  | Task attachments and the attach picker labelled files with the classifier key — `image`, `video`, `landing`, `archive`                                                                                                                                                                                  | `CATEGORY_LABEL` beside `KIND_LABEL`; both surfaces read it                                                                                                                      |
| H7  | The trash view offered a Tiles/List switch that switches nothing there                                                                                                                                                                                                                                  | hidden in the trash                                                                                                                                                              |
| H8  | Search results stacked four full-height buttons under every hit                                                                                                                                                                                                                                         | caption-weight, 32 px, left-aligned                                                                                                                                              |

Regression tests: H1, H2, H4 (`tests/team-explorer-keyboard-layout.test.tsx`), H3
(`tests/team-intent-audit-sql.test.ts`, on the real function through PGlite), H6
(`tests/creative-library-tasks.test.tsx`). H5, H7, H8 are stylesheet and markup, verified on
screen. Also fixed on the way: `tests/team-routes.test.ts` read `.query` off the route union
without narrowing and failed `typecheck:tests`.

Verified live after the fixes: `/` opens and focuses the search; rename from the keyboard
with a space in the name; Delete → "Переміщено в кошик · Скасувати" → "Відновлено"; the
history reads "Файл переміщено в кошик" and "Файл відновлено з кошика"; attachment captions
say "Зображення".

### Seen, left alone

- The global header's "БЕТА" badge sits on top of the support chip ("$0 / $99") below about
  1100 px. It is the application header, not the workspace; noted for its own stream.
- The first tile screen after `beta:up` came up blank for a few seconds — the edge function
  compiling on first hit — and filled on its own. Not reproducible once warm.
- A search hit's four actions still take two lines in a 380 px column; they are readable now.

## I — the root replaced with a real folder (2026-08-29, late)

The owner swapped the 19-file test folder for their own `Soty` folder. The chip read
"Індексуємо · файлів поки що: 0 · папок прочитано: 0" and stayed there. Two separate
causes, one a bug and one the answer to R1.

| ID  | What was wrong                                                                                                                                                                                                                                                                                                                                                                                                                        | Fix                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | The scheduler starved the new root's scan. `private.claim_catalog_sync_jobs` leased any job in `next_attempt_at` order; the public wrapper dropped detached connections only _after_ the lease. The replaced root's old job — first in the queue — took the worker's single slot every minute (128 attempts, lease renewed each time), and the new job ran 4 times in an hour                                                         | migration `20260829150000`: the claim joins the connection and skips detached ones; orphaned jobs of detached connections are closed as `failed / CONNECTION_DETACHED`. `tests/team-sync-claim-sql.test.ts`                                                            |
| I2  | Even when it ran, the initial scan of `Soty` found nothing — and it was right. Asked directly with the stored `drive.file` token: `files.list` for the picked `Mock` folder returns **21** children (all uploaded by Soty), for the picked `Soty` folder **0**, while `files.get` and `canListChildren` succeed for both. **R1 outcome B**: under `drive.file` a picked folder does not carry the files a person put there themselves | recorded in `research.md` § R1 outcome. Not a code defect: the walk is correct for what the scope shows. The way through is the restricted `drive` scope (`DRIVE_RESTRICTED_SCOPE_APPROVED=true`, consent screen lists it; Testing status lets test users consent now) |

| I3 | With the scope widened and a full walk queued, the catalog grew by **one Drive page per minute**: the scheduler ticks every minute and the worker ran one slice per tick, so a fifty-folder tree was an hour's wait | `runCatalogSyncJob` (engine): slices back to back within an 8 s budget per tick, each still checkpointed; 4 → 22 → 95 materials in three ticks on the real folder. `CATALOG_SYNC_BUDGET_MS` overrides |
| I4 | A re-consent that widened the grant changed nothing on screen: the job stayed `incremental`, and the change feed never replays files that were there all along, so the real folder stayed at 0 until "Синхронізувати зараз" was pressed by hand | migration `20260829160000` + `drive-oauth-callback`: a re-consent of an existing credential queues a full walk (`service_request_catalog_rescan`, owner-checked, one open scan at a time). And "Підключити знову" on a connected space now shows the "Продовжити з Google" step at all — the link lived only in the not-connected branch |

After I1 the connection reached `ready` within a minute and the chip settled on
"Сховище актуальне" — over an empty catalog, which is what I2 makes of a real folder until
the scope is widened. With the scope widened (consent screen + `DRIVE_RESTRICTED_SCOPE_APPROVED=true`
in the beta env, re-consent through the settings) `files.list` on the same root returned its
three subfolders, and after I3/I4 the walk filled the catalog from the owner's real tree. Regression tests: I1 (`tests/team-sync-claim-sql.test.ts`), I3 (`tests/catalog-sync.test.ts`),
I4 (`tests/drive-connect.test.ts`, `tests/team-sync-claim-sql.test.ts`, `tests/team-connect-flow.test.tsx`).

Worth a sentence in the product: an empty root after a fresh connect
should say that Soty sees only what it uploaded or what was picked file by file, rather
than "Ця папка порожня".

## J — the owner's own tree, first look (2026-08-30)

With the real folder indexed (95 materials, 27 folders), two things the owner saw at once.

| ID  | What was wrong                                                                                                                                                                                                                                                       | Fix                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1  | A picture or a clip did not fit the preview dialog: `70vh` of media plus the heading and padding was taller than the dialog's content area on a laptop screen (content 440 px, inside it 448 px at a 583 px viewport), so the last rows hid behind a scrollbar       | `styles.css`: the media is capped at the dialog's height less the chrome, width follows the aspect ratio, the content area does not scroll; a 720×720 clip now sits whole at 385 px                                                                                                                                                                                                                                          |
| J2  | The six landing packages in the tree were **archives**. Only the agent ever looked inside a ZIP, and only on preview — the known gap from section G, now the common case                                                                                             | `_shared/zip-directory.ts` reads a ZIP's central directory from its tail (one range request, ≤ 64 KB; a second only when the directory lies further up) and applies the agent's landing rule and fingerprint; `preview-warm` runs it over new archives each pass (migration `20260829170000`: claim once, commit for the version seen). All six became landings on the first pass; four rendered on the agent within minutes |
| J3  | Two of the six came back `unavailable`: Drive answers `403 cannotDownloadAbusiveFile` for them ("identified as malware or spam") — landing ZIPs with obfuscated scripts trip Google's heuristic, and the owner can still download them in Drive with a click-through | The inspection and the sandbox/agent read (`preview_range`) pass `acknowledgeAbuse=true`; a download to disk (`download_range`) keeps Google's refusal. Both promoted on the second pass; their renders were re-queued                                                                                                                                                                                                       |
| J4  | A landing tile with its render said "У Google Drive ще немає мініатюри для цього файлу" underneath                                                                                                                                                                   | the provider-thumbnail note is not shown for landings                                                                                                                                                                                                                                                                                                                                                                        |

Regression tests: J2 (`tests/zip-directory.test.ts` on real ZIPs built with yazl, including the
directory-outside-the-tail case and the fingerprint against the agent's digest;
`tests/team-archive-inspection-sql.test.ts` for claim-once and the version guard). J1 and J4 are
stylesheet and markup, verified on screen.

## K — the owner at the list (2026-08-30)

| ID  | What was wrong                                                                                                                                                                                | Fix                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | "Скачати" saved the file as `range`: the anchor's `download=` is ignored across origins (5175 → 54321) and the function sent a bare `attachment`                                              | `drive-transfer`: `Content-Disposition` carries the material's name (`filename` ASCII fallback + `filename*` UTF-8)                          |
| K2  | "Обробити" in the explorer's row menu did nothing — the menu had the button, the explorer passed no handler                                                                                   | the catalog's dialog → local run → operation view lifted into `MaterialProcessFlow`, used by both; the menu hides the item without a handler |
| K3  | On a tile the checkbox and the menu were 20 px and 28 px, at different heights; the menu's "···" glyph sat off-centre; the list wrote "Дії" where tiles had dots, with a bare native checkbox | one 28 px control style (`.team-explorer-check`) on tiles and rows; three drawn dots centred by flex; the list uses the same icon button     |
| K4  | The selection bar ran past its own border at the content column's width, "Обрано: 2" wrapped                                                                                                  | wraps, caption-weight buttons                                                                                                                |
| K5  | List rows read as loose text                                                                                                                                                                  | ruled columns name / kind / size; the name is the one green, opening control with the full name on hover; the rest of the row selects        |
| K6  | The tool `<select>` in the process dialog clipped its text (global 36 px height under 10 px padding) and lost its chevron to a `background` shorthand                                         | auto height, ≥ 44 px, `background-color`                                                                                                     |

Tests: K1 (`tests/drive-transfer.test.ts`), K2 (`tests/team-file-operations.test.tsx` — the item
needs a handler). The rest is markup and stylesheet, verified on screen.

## L — share by link, and the list gets a table (2026-08-30, continued)

Owner requests while testing on the real folder, each its own commit:

- **Share by link** on every row, tile and folder, left of the "···" menu: one press gives
  everyone with the link read-only access (Drive `anyone` reader), copies it, and a green
  "Посилання скопійовано" confirms. `ShareButton` over `library-ops/share/copy` with
  `allowIfRestricted`; `tests/team-share-button.test.tsx`.

Still open from the same run, in the owner's order: the drag-into-folder error (then "file
exists" — a stale reservation from a move that failed after Drive had already moved it, or a
non-idempotent retry; needs a clean repro), a modified date in previews and tiles, and a
Google-Drive-style list (a Date column, a sort menu, a "Тип" filter dropdown replacing the
kind chips).

## M — the drag-into-folder error (2026-08-30)

Dragging a file onto a folder failed with "something went wrong", and the second try was
refused with "a file with that name already exists" — for a file that was not there.

**Cause (M1).** A move reserves the destination name through `service_start_team_operation`,
which holds it on a unique index until the operation ends or fifteen minutes pass. Nothing
marked a _failed_ move failed: `handleMove` let the error propagate and the operation stayed
`running` with the name still reserved. The retry — a new drag, so a new idempotency key —
tried to reserve the same name and hit the index: `NAME_CONFLICT`, surfaced as "file exists".

**Fix.** `withOperationFailure` wraps the move and rename mutations: on any error it transitions
the operation to `failed` (which `service_transition_team_operation` already made release the
reservation) before re-raising, so the next attempt reserves the name cleanly.
`tests/team-operation-reservation-sql.test.ts` pins the contract: the reservation blocks a
second attempt while held, and a `failed` transition frees it.

The _first_ error ("something went wrong") still wants a clean repro to name its own cause —
the reservation fix makes the retry work regardless of what tripped the first attempt.

## N — processing refused every file (2026-08-30)

"Обробити" ended in "Частина даних некоректна" and did nothing: `drive-ops/process/start`
answered `400`. `handleProcessStart` read the destination with `requireUuid`, but the explorer
names a folder by its provider id (or omits it for the space root, "beside the original"), so
the guard rejected the request before the resolver that move and upload already use could run.
It now reads the destination with `optionalDestination` and resolves it to a material id
through `destinationWithClient`, so a process starts (`202`) and its output lands beside the
original by default.

## O — the list, the way a drive does it (2026-08-30)

The explorer's toolbar took the shape of Google Drive's, at the owner's request:

- **View toggle** is two icons — a list of rows and a grid — not the words "Плитки/Список".
- **"Тип" dropdown** replaces the kind chips: one button, a menu of kinds to check, the choice
  summarised on the button with a clear control. Folders are never filtered.
- **Sort menu**: a button showing the current key and direction opens a menu of the sort key
  (Назва / Дата змінення), the order (А→Я / Я→А), and whether folders group apart from files.
  The choice is remembered per browser; the sort is applied to the loaded page (a full-order
  sort of a folder larger than a page is a server concern, noted for later).
- **Modified date** already lives in the list as its own column and under each tile (finding
  from the same run).

`KindFilterBar` gave way to `KindFilterMenu` + `SortMenu`; `sort.ts` holds the ordering and its
persistence; `tests/team-explorer-filters-search.test.tsx` covers the menu, and the capability
map and `contracts/explorer-ui.md` were updated.

### Still to run (needs the owner)

Done so far under T076: the beta OAuth client (`soty-beta`, `drive.file`,
`DRIVE_OAUTH_MODE=testing`), the Picker key and project number in both env files, and a real
connection to a 19-file folder with no subfolders. What is left:

| Item                                                                            | Task  |
| ------------------------------------------------------------------------------- | ----- |
| Reference root built per `quickstart.md` §0 (≥ 4 levels, > 1,000-child folder…) | T076  |
| Production Google Cloud project                                                 | T076a |
| R1 spike (`quickstart.md` §1), outcome A/B                                      | T002  |

With the reference root in place: §2's tree rows, the network-cut timing row, the
revoke-and-reconnect trial and the root-trashed case; §3's cold-open timing and the
agent-at-lowest-power rows; §4's three-person and width matrix rows; and §5 from both
accounts remain. Everything that a flat 19-file folder can show has been run (section G).

### Noted, not ours

`tests/landing-preview-catalog.test.ts` ("renders multiple landings concurrently")
asserts a peak concurrency of `min(4, cpus)`. It failed once in the full suite while
the beta stack held four of the machine's eight cores, and passes alone. The file
belongs to the release stream (`2c209a2`), so it was left untouched; the assertion is
worth making load-tolerant once that stream is free.

## Production (after the next agent release, research R8)

Date: ____ · owner account: ____ · §6 result: ____

## P — the batch, and a way to stop it burning the machine (2026-09-02)

Two owner briefs, one afternoon, both about the same panel.

### "Process this folder" meant one level

A creative library is folders of folders, so reading only the open folder's direct children
made the command useless where it matters: on a country folder it answered "nothing inside
needs processing", and on a folder of shoots it offered the single landing sitting at the top
while ignoring the six below. `scanFolderTree` (`apps/web/src/team/explorer/folderScan.ts`)
now walks the subtree breadth-first through the same listing the explorer uses, skips a folder
it has already listed (a shortcut can point back up), and stops at 500 folders — which it says
out loud rather than pretending the tree ended. Each transcript is written beside its own
video; a hundred of them piled at the batch's root would be worse than none.

Verified in the beta on `spy суглоби`: 6 folders, 16 videos to transcribe (2 already had
transcripts), **6 landings where the old dialog saw 1**. "Refresh landing previews" marked all
six stale and the background render loop brought every one back to `ready`.

### Pausing the batch

`Пауза` in the queue panel holds two things: nothing new starts, and the file already in
flight is suspended too. The second half is the point — a pause that leaves twenty minutes of
whisper running is not what anyone pressed it for — and it needed a path all the way down:

| Layer                              | What it does                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcribe()` handle              | `setPaused` takes a governor **hold** on the whisper child (never a SIGSTOP of its own: the duty cycler would wake it at the next on-window, and Windows has no such signal), re-applies it to the next child of a multi-stage run, and lets go before a kill |
| `TranscriptionQueue.setPaused`     | names the running job, or reports `not-found`                                                                                                                                                                                                                 |
| `JobQueue.setPaused`               | converted from a raw `SIGSTOP` to the same hold, so a paused encode stays paused under a reduced power limit, and the hold follows the child a held final image changes mid-run                                                                               |
| `TeamProcessBridge`                | delegates offer a `pausable`; the run's wall-clock budget stops while held (paused time is not spent time); cancel and shutdown resume first, because a stopped process never sees SIGTERM                                                                    |
| `POST /api/team/process/:id/pause` | `409 NOT_PAUSABLE` rather than a quiet success when there is nothing to hold                                                                                                                                                                                  |
| Explorer panel                     | says which pause it got: "поточний файл теж призупинено" or "поточний файл дороблюється"                                                                                                                                                                      |

Corner cases that shaped it, in case they come back:

- **A page that goes away.** The agent does _not_ stop a team run when the browser
  disconnects — it finishes and uploads the result, which is right: a reload should not cost
  anyone fifteen minutes. Measured in the beta, it does not even _see_ the disconnect — after
  a reload the socket stayed `ESTABLISHED` and the handler kept running, so `request.raw`
  never emitted `close` and a resume wired to it never fired. A pause therefore cannot be tied
  to the connection: the page re-asserts it every 30 s and the agent lets a hold go after 120 s
  of silence. Verified live — the child sat at `T` with the tab gone, then went back to `S` two
  minutes later and finished the transcription on its own.
- **"Stop after current" while paused** would leave a suspended file as the last thing the
  panel ever did, so it lets the current one go.
- **Pause pressed in the second before the operation has an id**: the hold is taken as soon as
  there is one, asked once per operation.
- **The stall watchdog** was killing a silent child after ten minutes; a held child is silent
  by construction, so it re-arms instead.
- **An older agent** answers "nothing held" and the panel says the current file is finishing —
  which is exactly what the beta showed live, since its bundled agent predates the contract.

The pause of the _running_ file needs an agent carrying `teamProcessPause: 1`
(`npm run beta:down && npm run beta:up` rebuilds the local one); the queue half works against
any agent. Covered by `tests/team-bridge.test.ts` (six cases) and
`tests/team-queue-pause.test.ts`.

## Q — the ten-minute cliff (2026-09-02)

Found while proving the pause, and worth more than the pause itself: **every team
operation longer than ten minutes finished its work and then threw it away.**

A transcription that ran through a busy period reached its upload and died with
`PERMISSION_DENIED` — raised by the agent's own grant check, before the request even left the
machine. The grants a run is given were minted with `TRANSFER_GRANT_TTL_SECONDS` (10 minutes),
which is right for a transfer that begins at once and wrong for a ticket spent _after_ a whole
transcription. Every run that succeeded on the beta took 1:38, 3:00, 6:09, 8:20 — under the
line. Nothing above it ever could.

`OPERATION_GRANT_TTL_SECONDS` (6 hours, matching the agent's own watchdog for one run) now
covers both grants `process/start` issues; the short TTL stays for the transfers it was meant
for. Verified live: the grants minted after the change carry `05:59:59`, the ones before it
`00:09:59`.

A failed item also used to leave its operation `running` for good — nothing revisits it, and
it holds its output name reserved, so the next attempt at the same file is refused for a
conflict with a run that is not happening (which is exactly what a re-transcribe of
`16-tail.mp4` hit here, `409`). The queue now closes the operation it started when the local
half fails.

## R — a repeat transcript kept collecting parentheses (2026-09-02)

Owner, from a screenshot of the folder: the transcripts no longer match their videos.
`16-tail.mp4` had `16-tail (2).txt` beside it, and 012's FR-T2 says the transcript is named
after its video.

Both halves were working as written, and together they were wrong. A repeat is written while
the transcript it replaces is still live, so the name it asks for is taken and the conflict
rule (`keep_both`) hands it `16-tail (2).txt`. The old companion is retired and trashed during
that _same_ finalize — which frees the canonical name a second later — but nothing goes back
for it. Run it again and the file is `16-tail (3).txt`; the parenthesis is permanent and the
count grows with every repeat.

The deeper half: `service_link_transcript_companion` retired the old companion **in the catalog
only**. The file stayed in the Drive folder — invisible in Soty, still holding the name — so
the folder Soty showed and the folder Drive held had quietly diverged, and every plan after
that saw the name as taken. Proof, from the page's own console:
`renameMaterial(… '16-tail.txt' …)` answered `NAME_CONFLICT` while Soty listed no such file.
The function now reports what it retired and `finalize` trashes those files in Drive too,
best-effort and logged.

With the name free, the batch asks for the canonical one once the run lands, with
`conflictMode: 'cancel'`:
if something live still holds it, the output keeps the name it landed with rather than
becoming a duplicate. First transcriptions are unaffected — they already get the name they
asked for, and the rename is a no-op.

Not chosen: uploading the repeat as a new Drive version of the existing transcript. That is
the nicer outcome (one file, Drive's own history) but `process/start` only allows a version
target that _is_ the source material, and widening that is a change to the finalize
authorization path — worth doing deliberately, not as a naming fix.
