# Quickstart — proving 024 works

Everything here runs against the local beta stack. This machine runs one heavy process at a time:
check `uptime` first, never run `npm run verify` here (CI runs the aggregate), and run vitest
single-fork.

## Prerequisites

```sh
uptime                                   # load must be calm before a build
colima start                             # only after a reboot
npm run beta:down                        # clears stale ownership
npm run beta:up                          # web 127.0.0.1:5175, agent 43140, supabase 54321
```

`scratchpad/beta/session.mjs` drives the beta through Playwright when a browser tab is not
wanted; a Chrome tab costs six of the agent's sockets, so prefer the driver for long sweeps.

No migration is involved in this feature, so `npx supabase migration up --local` is not needed
and **`db reset` must never be run** — it wipes the space with no backup.

## Gates, run individually

```sh
node scripts/check-design-tokens.mjs        # raw values in CSS — must stay silent
node scripts/check-tailwind-classes.mjs     # NEW: literal values in utilities
node scripts/verify-styles.mjs              # var() with nothing behind it
npm run lint
npx prettier --check apps/web
npx vitest run --pool=forks --poolOptions.forks.singleFork=true tests/ui-consistency.test.tsx \
  tests/design-token-contract.test.ts tests/stylesheet-integrity.test.ts \
  tests/theme-bridge.test.ts tests/material-action-registry.test.ts \
  tests/material-action-surfaces.test.tsx tests/team-raw-controls.test.ts \
  tests/task-editor-autosave.test.tsx
npm run build -w @video-compressor/web      # type errors only surface here
```

## Checkpoint 1 — foundation

1. `http://127.0.0.1:5175/design` renders, in both themes.
2. Toggle the theme: the 775 ms cross-fade still runs, nothing flashes, no surface loses
   contrast.
3. A HeroUI button placed on `/design` beside an inventory button shows the **same** honey, the
   same radius and the same focus ring — that is the bridge working.
4. Every existing screen still looks as it did: Tailwind's preflight is not imported, so nothing
   un-migrated moved.
5. `tests/theme-bridge.test.ts` passes, including "every variable the library reads is defined".

## Checkpoint 2 — the inventory

1. `/design` shows every component in every variant, size and state, both themes.
2. Walk the screens **outside** the team workspace — compressor, transcription, stitcher, auth,
   landing viewer — and find them working and visually coherent. They were not edited; they
   inherited.
3. `tests/ui-consistency.test.tsx` passes unchanged. If it passes *vacuously* — check that the
   adapters still emit markers; an empty signature is a silent failure.
4. Keyboard: open a menu, a dialog inside it, press Escape twice — the inner surface closes
   first, focus returns to each trigger.

## Checkpoint 3 — material actions (the owner's example)

This is the acceptance test of the whole feature.

1. In the beta space, create a task and attach a video to it.
2. Open the task. Type something in the note and **do not** look for a Save button.
3. Open the attachment's actions. Confirm the groups read: open · get · make · organise · remove,
   with the destructive item last and separated.
4. Choose **Product catalog**. The dialog opens **over the task**.
5. Create the catalog. On success: the task is still open, the note still holds what was typed,
   and the attachment now shows its catalog with open / copy link / remake.
6. Open the same video's actions from a folder row, a grid tile, a search result and the updater's
   list. The list, its order, its grouping and its wording are identical.
7. Disconnect Drive in space settings and re-open the actions: "Product catalog" is still there,
   with one line saying why it cannot run now — not grey and silent.
8. Open the actions on a **folder**: "Product catalog" is absent, not disabled.

## Checkpoint 4 — tasks

1. Change title, status, assignee, date, progress and note. Nothing asks to be saved. Reload:
   everything is there.
2. Close the editor by every route — the ✕, Escape, Back, a material action's navigation. No
   prompt, nothing lost.
3. Attach by the picker and by drop. Both behave identically.
4. Detach one, press Undo in the toast, it comes back.
5. Open the date filter: one calendar, HeroUI's, in Soty's colours, with the quick ranges beside
   it. Drive it from the keyboard across a month boundary.
6. Trash a file that is attached to a task, then open the task: the attachment says "in the
   trash" in words and offers restore.

## Checkpoint 5 — explorer, search, discoverability

1. `/` still opens search; search results now carry the detail surface, the colour tag and share.
2. Right-click a row: the same grouped menu opens at the pointer. Right-click inside a checked
   selection: it acts on the selection and says how many.
3. ⌘K anywhere in the workspace: type a task's name, press Enter, land on it. Type a file's name,
   highlight it, run an action from the palette.
4. Open the shortcut sheet: every binding the product makes is listed, and each one also appears
   in the tooltip of the control it duplicates.
5. A 500-row folder scrolls to the bottom without repeated manual paging.

## Checkpoint 6 — accounts, members, chrome

1. From **Tasks**, open space settings, close it: still on Tasks, same filters, same scroll.
2. Trash is reachable from every section.
3. Members exists once.
4. The accounts table folds its money column with no cell leaving its column; every identifier is
   selectable; a tag chip with a count filters to what it counted; Free/Busy filters when pressed.
5. An invitation that was revoked says "revoked".
6. Space history offers more than its first page.

## The sweep that decides "gorgeous"

Walk every team screen at **390 px** and **1440 px**, in **both themes**, with reduced motion on
and off. Photograph each. The rules being checked by eye:

- one primary action per surface, at the end of the reading order;
- no state told by colour alone;
- no empty, loading, error or permission state that is only a sentence;
- nothing overflowing horizontally; no unlabelled icon row where a label would fit;
- no menu over seven items without headings.

## Weight, measured once at the end

```sh
npm run build -w @video-compressor/web
npx vitest run --pool=forks --poolOptions.forks.singleFork=true tests/performance-budgets.test.ts
```

It will fail against the old baseline. Re-ratchet `performance-baseline.json` **once**, with a
note naming both halves: the library added and the CSS deleted. A failure that is re-ratcheted
without that note is a budget nobody will respect again.

## Leftovers to clean on the beta

The beta space still carries artefacts from earlier features — re-stitched copies, a "Reveal
test" task, test catalogs. Remove them before the visual sweep so the screenshots show the
product rather than the test bench.
