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
