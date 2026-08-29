# Contract — Explorer UI

## Routes (`apps/web/src/team/routes.ts`)

| Route                     | Section    | Query                                                                         | Notes                                                                                         |
| ------------------------- | ---------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/team/:spaceId`          | `explorer` | `folder`, `kind` (csv), `q`, `scope=folder\|space`, `item`, `view=grid\|list` | default; last folder/view/filter restored from local storage when the query is empty (FR-030) |
| `/team/:spaceId/tasks`    | `tasks`    | `task`                                                                        | unchanged behaviour                                                                           |
| `/team/:spaceId/members`  | `members`  | —                                                                             | former Members panel                                                                          |
| `/team/:spaceId/landings` | redirect   | → `/team/:spaceId?kind=landing&view=grid`                                     |                                                                                               |
| `/team/:spaceId/library`  | redirect   | → `/team/:spaceId?kind=image,video&view=grid`                                 |                                                                                               |
| `/team/:spaceId/settings` | redirect   | → `/team/:spaceId` + opens the settings dialog                                |                                                                                               |
| `/team/:spaceId/trash`    | `explorer` | `trash=1`                                                                     | trash view inside the explorer content area                                                   |

## Layout

```
┌ header: space switcher · name · [StorageChip] · search ─────── Tasks · Members · ⚙ ┐
├ tree (280px, collapsible) │ content (grid/list) · KindFilterMenu · SortMenu · breadcrumb │ preview (360px) ┤
```

- `< 1024px`: tree becomes a drawer; `< 720px`: preview becomes a bottom sheet; usable at
  320px (FR-028).
- Keyboard: tree ↑↓ move, →/← expand/collapse, Enter open; content ↑↓←→ move selection, Enter
  open, Escape close preview, Delete → trash with undo; `/` focuses search (FR-027).

## Panes and components (`apps/web/src/team/explorer/`)

| Component                              | Responsibility                                                                                              | Data                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `ExplorerProvider` / `useExplorer()`   | tree cache, selection, filters, view mode, thumbnail session                                                | `listFolderTree`, realtime patches, `mintThumbnailSession` |
| `FolderTree`                           | virtualised tree, counts, "listing…" state, drag target                                                     | `TeamFolderNode[]`                                         |
| `Breadcrumb`                           | full clickable path from root/selection                                                                     | tree                                                       |
| `KindFilterMenu` / `SortMenu`           | a Type dropdown (landing · image · video · transcript · archive · other) and a sort menu (name/date, A–Z/Z–A, folders apart) | tree counts + page totals |
| `ExplorerSearch`                       | type-ahead within folder; scope toggle; results with paths                                                  | `search_materials`                                         |
| `ContentGrid` / `ContentList`          | paged rows, thumbnails via session URL, kind icon + reason, selection, context menu, drag source            | `listFolderPage`                                           |
| `PreviewPane`                          | wraps `MaterialPreview` (media/transcript/archive), `LandingFullView`, metadata editor, provenance, actions | existing clients                                           |
| `StorageChip` (`team/storage/`)        | one state at a time; click → detail sheet with actions                                                      | `useStorageHealth`                                         |
| `ConnectStorageFlow` (`team/storage/`) | name → Picker → done; selections list under outcome B                                                       | `picker_token`, `choose_root`, selections                  |

## Capability map (enforced by `tests/team-explorer-capability-map.test.ts`)

| Former surface              | Capability                                                                                                                           | New home                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Files                       | browse folder, open, rename, move, trash, restore, download (browser / agent), copy link, metadata editor, provenance, folder picker | ContentGrid/List row menu + PreviewPane                                  |
| Files                       | search + pager                                                                                                                       | ExplorerSearch (scope toggle)                                            |
| Files                       | trash view                                                                                                                           | `?trash=1` content view                                                  |
| Files                       | upload (single, folder, resumable)                                                                                                   | header "Add" + drag-drop onto content area                               |
| Landings                    | gallery tiles with render state                                                                                                      | ContentGrid with `kind=landing`, tile = first render segment             |
| Landings                    | full landing view + viewer controls                                                                                                  | PreviewPane → `LandingFullView` (expand to full-screen)                  |
| Landings                    | render / cancel render                                                                                                               | row menu + PreviewPane action; background loop status on chip            |
| Library                     | asset cards with visual preview                                                                                                      | ContentGrid `view=grid` with thumbnails                                  |
| Library                     | bulk upload dialog                                                                                                                   | header "Add" → bulk mode                                                 |
| Library                     | process (transcribe / translate / optimise) single + batch; background chip                                                          | row menu + multi-select action bar; `BackgroundWorkChip` stays in header |
| Library                     | share actions, copy Drive link                                                                                                       | row menu + PreviewPane                                                   |
| Library                     | video text actions (copy transcript etc.)                                                                                            | PreviewPane transcript tab                                               |
| Settings                    | space name, storage panel, permissions, ownership transfer, audit, delete                                                            | header ⚙ dialog (tabs)                                                   |
| Members                     | list, invite, permissions, transfer ownership                                                                                        | `/members` section (unchanged components)                                |
| Sync banner / realtime chip | sync state, live state                                                                                                               | StorageChip + `RealtimeChip` in header                                   |

## Files removed after the merge

Removed (unreachable once the explorer is the only primary screen):
`team/catalog/MaterialBrowser.tsx`, `team/landings/TeamLandings.tsx`,
`team/landings/LandingGallery.tsx`, `team/landings/LandingGalleryTile.tsx`,
`team/library/CreativeLibrary.tsx`, `team/library/LibraryAssetCard.tsx`,
`team/library/LibraryAssetVisualPreview.tsx`, `team/drive/DriveFolderBrowser.tsx`,
`team/create/ConnectFolderStep.tsx`, and — once the storage chip (US4) landed —
`team/SyncProgress.tsx` with `team/useCatalogFreshness.ts`. Their tests were ported to
`tests/team-explorer-*.test.tsx`, `tests/creative-library-filters.test.tsx` and
`tests/landing-viewer-controls.test.tsx`; the gallery-only presentational cases were dropped
with the gallery.

Kept on purpose (they _are_ explorer parts now): `team/catalog/TeamCatalog.tsx` and
`team/catalog/MaterialResults.tsx` are the explorer's search view (scope toggle, facets,
pager, row actions, path per result); `team/workspace/SpaceSettings.tsx` is the body of the
settings dialog;
`team/landings/useTeamLandings.ts` keeps `deriveLandingGalleryItems` for the tile-state rule.

## Analytics

`team_storage_connected { selections }`, `team_index_completed { folders, files, seconds }`,
`team_previews_ready { ready, unavailable, seconds }`, `team_storage_attention { reason }`;
existing `team_find_*`, `team_file_attempt_*`, `team_preview_*` keep firing from the new homes.
