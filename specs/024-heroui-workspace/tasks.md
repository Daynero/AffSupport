---
description: 'Task list for 024 — the team workspace on HeroUI'
---

# Tasks: The team workspace on HeroUI

**Input**: Design documents from `/specs/024-heroui-workspace/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: included. The spec's success criteria are mechanical — an identical action list across
five surfaces, zero raw controls, no menu over seven ungrouped items — so they are written as
tests rather than checked by eye. The part that cannot be mechanised, "clean and gorgeous", is
the visual sweep in Phase 12.

**Organization**: by user story. Each phase leaves the app working and is verifiable on the beta
against the matching checkpoint in [quickstart.md](./quickstart.md).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1–US9 from the spec; setup and foundational tasks carry none

---

## Phase 1: Setup — the ground the library stands on

**Purpose**: make the decision legitimate, then install it. Nothing visual changes here.

- [x] T001 Amend Principle VI in `.specify/memory/constitution.md` per research D8 — the token
      layer is the only source of values, the inventory the only source of controls, utilities
      the only way to write new style, theming stays CSS custom properties + `data-theme`. Bump
      2.0.0 → 3.0.0 with a Sync Impact Report in the file's header comment.
- [x] T002 [P] Restate the amended rule in `CLAUDE.md` ("Anything visual goes through the design
      system") and in `AGENTS.md` wherever the one-global-stylesheet rule is repeated.
- [x] T003 [P] Rewrite the Токени and Інвентар компонентів sections of `docs/DESIGN.md` for the
      new mechanism, keeping every product rule — icon size, picto groups, inline fields,
      validation, one primary per surface — verbatim. Those rules do not change.
- [x] T004 Add exact-pinned dependencies to `apps/web/package.json`: `@heroui/react` 3.2.5,
      `@heroui/styles` 3.2.5, `react-aria` 3.52.1, `react-aria-components` 1.21.1,
      `@react-aria/i18n` 3.13.1, `@react-aria/ssr` 3.10.1, `@react-aria/utils` 3.34.1,
      `@internationalized/date` 3.12.4; dev: `tailwindcss` 4.3.1, `@tailwindcss/vite` 4.3.1. No
      caret, no `latest`.
- [x] T005 Add `tailwindcss()` to `plugins` in `apps/web/vite.config.ts`, and a `heroui` group to
      `build.rollupOptions.output.manualChunks` beside `react` and `supabase`.
- [x] T006 [P] Record the new dependency tree and its licences in `THIRD_PARTY_NOTICES.md` —
      HeroUI MIT, the React Aria packages Apache-2.0.
- [x] T007 [P] Run `node scripts/audit-dependencies.mjs`; resolve or date-stamp anything it
      blocks on.
- [x] T008 Build once and record the **before** weight — total, entry and largest gzipped chunk —
      into `specs/024-heroui-workspace/findings.md` as a stub. T143 needs a number to compare
      against, and after Phase 3 it is no longer obtainable.

**Checkpoint**: `npm install` succeeds, the web build still builds, nothing on screen changed.

---

## Phase 2: Foundational — the theme bridge and the fence

**⚠️ No user story work begins until this phase is complete.**

- [x] T009 Create `apps/web/src/styles/index.css` — the one stylesheet entry. It declares the
      ladder `@layer theme, base, soty-legacy, components, utilities, soty;`, imports Tailwind and
      `@heroui/styles`, binds the `dark` variant to `[data-theme='dark']`, and holds the
      `@theme inline` block. Create `apps/web/src/styles/skin.css` for the `soty` layer.
- [x] T010 Import every pre-024 sheet into `layer(soty-legacy)` from `styles/index.css`, and make
      `apps/web/src/main.tsx` import that one file instead of eight.
- [x] T011 Add the HeroUI variable block to `apps/web/src/styles/tokens.css` per
      `contracts/theme-bridge.md` half 1 — light and dark, every right-hand side a Soty token,
      `--field-border-width: 1px` as the one deliberate override of the library's look.
- [x] T012 Reconcile stacking. React Aria portals to `body` with its own stacking; the product
      has a sixteen-rung `--layer-*` ladder. Map HeroUI's overlays onto it so a toast still sits
      above a modal and a nested confirm above its parent's backdrop — the exact failure that hid
      the updater's stop confirmation in feature 023.
- [x] T013 Reconcile the bases. `@heroui/styles` ships its own `base.css` and `scrollbar.css`;
      the product has `apps/web/src/styles/base.css`. Decide which survives and record the
      reasoning at the top of `styles/index.css`.
- [x] T014 Make HeroUI's animations obey `prefers-reduced-motion` — the library pulls
      `tw-animate-css`, and the product's rule is that everything collapses to 1 ms except the
      spinner, which slows to `--motion-spin-reduced`.
- [x] T015 Write `tests/theme-bridge.test.ts`: every variable the installed `@heroui/styles`
      reads is defined by the bridge; no literal on any right-hand side; light and dark differ
      per role; `@theme` is declared `inline`; preflight is not imported.
- [x] T016 Write `scripts/check-tailwind-classes.mjs` per research D6 — fail on an arbitrary
      value in a utility (`bg-[…]`, `rounded-[…]`, `duration-[…]`, `text-[…]`) and on a palette
      step that is not a Soty role, anywhere under `apps/web/src`. Local `fail()` → stderr +
      exit 1, human confirmation line on success, per the script conventions.
- [x] T017 Register the new gate in `scripts/verify-all.mjs` beside `design-tokens` and `styles`.
- [x] T018 Confirm `node scripts/check-design-tokens.mjs` still passes untouched and that
      `config/design-token-exemptions.json` is still empty — if it is not, the bridge leaked a
      literal.
- [x] T019a Rename the twelve class names this product shares with HeroUI's component base
      classes — `button`, `card`, `checkbox`, `empty-state`, `field-error`, `pagination`,
      `progress-bar`, `skeleton`, `spinner`, `toast`, `toast-region`, `tooltip` — to a `soty-`
      prefix across components, stylesheets and the tests that select on them. Without it the
      library's base rules and this product's pre-021 rules fight over the same elements.
- [x] T019 Add a `foundation` section to `apps/web/src/dev/DesignSystemPage.tsx` rendering a bare
      HeroUI control beside its inventory counterpart, so the bridge is visible before any
      component is migrated.

**Checkpoint**: quickstart Checkpoint 1.

---

## Phase 3: User Story 2 — one vocabulary of controls (Priority: P1) 🎯 MVP

**Goal**: every inventory component is HeroUI underneath, keeps its API and its markers, and the
whole product inherits the new look at once.

**Independent Test**: `/design` shows every component in both themes; screens outside the team
workspace work untouched; `tests/ui-consistency.test.tsx` passes non-vacuously.

- [x] T020 [US2] Extend `apps/web/src/components/ui/types.ts`: keep `uiClasses()` emitting the
      marker grammar, and add — in one place — the variant maps translating Soty's
      `color` × `variant` × `size` onto HeroUI's own props.
- [x] T021 [P] [US2] `Button`, `IconButton` (and `Checkbox`, `Switch`, `Slider`,
      `SegmentedControl`, `RadioGroup` pictos — T026) onto HeroUI in
      `apps/web/src/components/ui/Button.tsx`; `loading` keeps the control's width.
- [x] T022 [P] [US2] `Badge`, `Chip` onto HeroUI `Badge` / `Chip` / `Tag` in
      `apps/web/src/components/ui/Badge.tsx`; removable chips use `Tag` inside a `TagGroup`.
- [x] T023 [P] [US2] `Card`, `Separator` onto HeroUI `Card` / `Surface` / `Separator` in
      `apps/web/src/components/ui/Card.tsx`.
- [x] T024 [P] [US2] `Alert` onto HeroUI `Alert` in `apps/web/src/components/ui/Alert.tsx`.
- [x] T025 [US2] (Select, InputNumber, SearchField done; Input and Textarea stay a real input
      and a real textarea — a native text field carries the platform's spellcheck, autofill, undo
      and mobile keyboards, which is why the library wraps one too) `FormField`, `Input`,
      `InputNumber`, `InputTags`, `Select`, `Textarea` onto
      HeroUI `Fieldset`/`Label`/`Description`/`FieldError`, `Input`/`InputGroup`, `NumberField`,
      `TagGroup`, `Select`, `Textarea` in `apps/web/src/components/ui/Field.tsx`; add
      `SearchField` and `SelectMenu` (ComboBox) as new exports.
- [x] T026 [US2] `Checkbox`, `RadioGroup` (including the `pictos` variant on
      `ToggleButtonGroup`), `SegmentedControl`, `Slider`, `Switch` in
      `apps/web/src/components/ui/Choice.tsx`; `indeterminate` becomes a prop and the `ref` poke
      into the DOM is deleted.
- [x] T027 [P] [US2] (Tooltip done; Empty/Progress/Skeleton/Spinner keep their own element —
      the library offers them only a class name) `Empty`, `Progress`, `Skeleton`, `Spinner`,
      `Tooltip` in
      `apps/web/src/components/ui/Feedback.tsx`; `Progress` keeps `--fill-ratio` + `scaleX()`;
      add `Kbd`.
- [x] T028 [US2] (DropdownMenu done, on React Aria's Menu with real sections, typeahead and
      Home/End; Modal, Drawer and Popover still use `useDialogBehaviour`, which now returns focus
      only if nothing else has taken it) `Modal`, `Drawer`, `Popover`, `DropdownMenu` onto HeroUI in
      `apps/web/src/components/ui/Overlay.tsx`; delete `useDialogBehaviour`, `focusableIn` and
      `FOCUSABLE_SELECTOR`; add `ContextMenu`; keep "a popover that opens a dialog must not
      close" as a prop.
- [x] T029 [US2] Collapse the two dialog implementations into one — **re-scoped after reading
      them**. The defect this task was written against is already gone: both shells have shared
      one open stack, one focus trap and one scroll lock since 021, so there is no race left to
      fix. What remains is two presentational shells with different class names, and 38 screens
      whose CSS is written against the older one. Repointing them in a single change is a wide
      edit with no visible result, so the legacy shell is deleted where its screens migrate
      instead — T134 owns the last of them. New code uses the inventory's `Modal`, which gained
      `initialFocus` here for the rename dialog.
- [ ] T030 [US2] `Breadcrumb`, `Link`, `Pagination`, `Tabs` onto HeroUI in
      `apps/web/src/components/ui/Navigation.tsx` — one keyboard behaviour for both tab strips,
      link mode included; add `Toolbar`; delete the second always-rendered compact breadcrumb.
- [ ] T031 [US2] **Deferred to Phase 10, with a reason.** The inventory's `Table` is a CSS grid
      whose columns are ruled by the screen that uses it — the explorer, the accounts table, the
      member list and the admin lists each set their own tracks against `.ui-table-row`. HeroUI's
      table is a real `<table>` with different DOM, so swapping it rewrites all four screens'
      column CSS at once. T116 rebuilds the accounts table; that is where this belongs, screen by
      screen, rather than as one change that cannot be checked in one sitting.
      `Accordion` → `DisclosureGroup` and `User` → `Avatar` are unblocked and stay here.
- [ ] T032 [US2] Patterns in `apps/web/src/components/ui/patterns.tsx`: `EmptyState`,
      `LoadingState`, `ErrorState`, `PermissionState` as compositions; `ConfirmDialog` onto
      `AlertDialog`; `SelectionBar` onto `Toolbar`.
- [x] T033 [US2] Create `apps/web/src/components/ui/DateField.tsx` — `Calendar`, `RangeCalendar`,
      `DatePicker`, `DateField` on HeroUI, with the one adapter between `CalendarDate` and the
      product's stored string shape.
- [ ] T034 [US2] Update the barrel `apps/web/src/components/ui/index.ts` with every new export.
- [ ] T035 [US2] Restyle the product's own toast in `apps/web/src/components/toast.tsx` onto the
      new surfaces — it keeps its tones, lifetimes, action and progress bar, and stays ours.
- [ ] T036 [US2] Retire the bespoke hover-bubble layer: `apps/web/src/components/InstantTips.tsx`
      and the `data-tip` attribute pattern give way to the inventory's `Tooltip` with one delay
      group; delete `useAnchoredLayer.ts` and `useCompactToolbar.ts`, whose jobs React Aria now
      does.
- [ ] T037 [US2] **Deferred to the sweep (T140), with a reason.** 56 files import the shim, and
      48 of them only for `Button`, which the inventory already accepts in its legacy spelling —
      so the repoint is mechanical. What is not mechanical is the checking: most of those files
      are outside the team workspace, and three of those screens cannot render at all without the
      local app, which is exactly the finding (021, S8) that says a screen nothing can open is a
      screen nothing has checked. It goes in the pass that walks them, not before it.
- [ ] T038 [US2] Rewrite `tests/design-components.test.tsx` from the deleted shim's literal
      classes onto the inventory's marker grammar.
- [ ] T039 [US2] Extend `apps/web/src/dev/DesignSystemPage.tsx` to every new component and the
      new dates group, generated from the type unions as it already is.
- [ ] T040 [US2] Delete from `apps/web/src/styles/components.css` every rule the adapters no
      longer need; confirm `node scripts/verify-styles.mjs` still reports no orphan `var()`.
- [x] T041 [US2] Repair the existing DOM test suite. All 113 files and 796 tests pass. 73 of the 113 `*.test.tsx` files render a
      component the swap changes; they assert on class names, roles and labels. Work through them
      in one pass, preferring role- and name-based queries to class-based ones, so the suite
      stops being coupled to markup it no longer owns.
- [ ] T042 [US2] Walk the screens outside the team workspace — compressor, transcription,
      stitcher, auth, landing viewer, 2FA, account page — and fix what the swap moved. Record
      anything deliberately left alone.

**Checkpoint**: quickstart Checkpoint 2. This is the MVP: the product already looks new.

---

## Phase 4: User Story 1 — finish the job where you are standing (Priority: P1)

**Goal**: one definition of what can be done to a material, rendered by every surface.

**Independent Test**: create a product catalog from a video attached to a task, without the task
closing or losing anything.

- [ ] T043 [US1] Lift the compression queue out of `apps/web/src/team/explorer/ExplorerShell.tsx`
      into `apps/web/src/team/processing/CompressionProvider.tsx`, mounted at the space level in
      `apps/web/src/team/workspace/WorkspaceShell.tsx` beside `LibraryProcessingProvider`,
      keeping pause / hold / stop-after-current / stop-now and the active-operation tracking.
- [x] T044 [US1] Write `apps/web/src/team/materials/actions.ts`: `MaterialRef`, `ActionContext`,
      `MaterialCompanions`, `MaterialAction`, `Availability`, and the registry of every action in
      `contracts/material-actions.md`, in its five groups and fixed order.
- [x] T045 [US1] Write `apps/web/src/team/materials/useMaterialActionList.ts` — resolve the
      registry against a material and a context into `{ inline, groups, count }`, at most four
      inline, empty groups omitted.
- [x] T046 [US1] Write `apps/web/src/team/materials/MaterialActionMenu.tsx` on the inventory's
      `DropdownMenu`: grouped with headings, icons, one-line reasons under unavailable items,
      the destructive group separated, last, and never focused first.
- [x] T047 [US1] Write `apps/web/src/team/materials/MaterialInlineActions.tsx` — the first N by
      `inlinePriority`, labelled or tooltipped per the product's icon rules.
- [x] T048 [US1] Write `apps/web/src/team/materials/MaterialActionHost.tsx` — mounts the dialogs
      an action opens (catalog, process flow, folder picker, rename, colour picker, compressor)
      **beside** its host, so nothing closes.
- [x] T049 [US1] Add the translation keys for every action, group heading and unavailability
      reason to `apps/web/src/i18n.ts`, Ukrainian and English.
- [x] T050 [US1] Extend `apps/web/src/team/errors.ts` with the new `UnavailableReason` codes and
      their sentences; no sentence is written anywhere else. `materialUnavailableMessage` is a
      total `Record<UnavailableReason, TranslationKey>`, so a new reason without a sentence is a
      type error, and the menu calls the mapper instead of holding its own copy.
- [x] T051 [US1] Preserve analytics through the registry: every action that today opens a
      `startTeamFileAttempt` / `startTeamWorkflow` pair keeps doing so, with the same typed event
      names, so no funnel goes dark when the call site moves. The pairs all live in hooks the
      registry's handlers call, so none moved — but the host was dropping `sizeBytes` on its way
      to `useMaterialActions`, which reported every download's size as unknown and made a large
      file try the browser path first. `MaterialRef` carries it now, and the bucket is pinned by
      `tests/team-file-operations.test.tsx`.
- [x] T052 [US1] Replace `apps/web/src/team/catalog/MaterialRowMenu.tsx` at its call sites with
      the shared menu, then delete it and its hand-rolled roving focus. Done: 379 lines gone.
      The behaviours it carried — trash and its undo, permissions answering separately, one
      outcome per action, bucketed analytics — moved to `tests/support/material-surface.tsx`,
      which renders the shared surface for a test rather than a screen.
- [x] T053 [US1] Render the shared surface from the explorer's rows and tiles —
      `RowActions.tsx` done, which both `ContentList` and `ContentGrid` render. Copy link, share
      and the colour tag still live as their own row affordances; they join the surface with the
      detail work in T086–T090.
- [x] T054 [US1] Render it from search results in `apps/web/src/team/catalog/MaterialResults.tsx`.
- [x] T055 [US1] Render it from the detail pane in `apps/web/src/team/explorer/PreviewPane.tsx`,
      replacing its three raw icon buttons.
- [x] T056 [US1] Render it from a task attachment in
      `apps/web/src/team/tasks/TaskAttachmentTile.tsx` — the owner's example. Six unlabelled
      icons become up to three inline plus one overflow.
- [x] T057 [US1] Render it from the catalog updater's list in
      `apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx`, through the new
      `UpdaterRowActions.tsx`. Two hand-written icons become the whole vocabulary. `detail` is
      scoped out of the `updater-row` host, and `showInFolder` is absent until
      `list_team_product_catalogs` returns the folder's id — the row names the folder but not
      its id, and the reveal needs the id.
- [ ] T058 [US1] Render it from the selection bar on the inventory's `SelectionBar`, with
      `host: 'selection'` intersecting over the checked set and labels that say how many.
- [x] T059 [US1] Show companions on the material wherever it appears — catalog, transcript,
      re-stitched copy — each with its own direct actions. `useMaterialCompanions` reads both
      where one file is in focus (the detail pane, a task attachment); `copyText` became a real
      handler on the host instead of an action nothing could run. A list does not call it fifty
      times: rows get companions from the list query or not at all, which is a column on the
      folder and search queries and therefore server work this branch does not do.
- [x] T060 [US1] Wire up `editText` in the folder view, which the audit found dead because the
      explorer never passed the handler.
- [x] T061 [P] [US1] Write `tests/material-action-registry.test.ts`: every action's translation
      key exists; no group over seven items without a heading; every destructive action is in
      `remove`; no host resolves more than four inline; the id union is closed.
- [x] T062 [P] [US1] Write `tests/material-action-surfaces.test.tsx`: the same `MaterialRef`
      resolved against every host yields an identical label key, icon, group and position for
      every action that applies in more than one host (SC-003).
- [x] T063 [P] [US1] Test that each action reports exactly one outcome, through the one toast
      channel, from the one error mapper — never a raw machine code on screen. Held by
      `tests/team-ux-feedback.test.tsx`, which now runs through the shared surface rather than
      the deleted row menu, and by the unavailability reasons being a total map in the one
      mapper (T050).

**Checkpoint**: quickstart Checkpoint 3. The owner's example works.

---

## Phase 5: User Story 3 — a task you can actually work in (Priority: P1)

- [x] T064 [US3] Give every form field in `apps/web/src/team/tasks/TaskEditor.tsx` its own
      coalesced writer through `useCoalescedWrite`, keeping the version check and surfacing a
      conflict as an explicit "take the newer value" choice rather than a snap-back. Done as
      `useTaskAutosave`: one writer, `save` for a gesture and `saveSoon` for typing, `flush` on
      blur and on close. The version comes from a ref, or two keystrokes would quote the same
      stale stamp and the second would conflict with the reader's own edit.
- [x] T065 [US3] Delete the staged-attachment concept, the `draftAttachment` shape, the
      sessionStorage draft, the unsaved-changes modal, the Save button and the "will be added on
      save" wording from `TaskEditor.tsx`. The draft shape survives as an optimistic tile for the
      moment between picking and the server's answer, and its badge says "Attaching…" — a fact
      about now, not a promise about a button.
- [x] T066 [US3] Make the picker attach on confirm, so picking and dropping agree. Detaching
      became immediate with it, which is what finally makes its Undo true: it used to promise to
      take back a change that had not happened.
- [x] T067 [US3] Add the quiet saved indicator and the loud retryable failure to the editor's
      header. "Saved" is a receipt that fades; a failure keeps the words on screen, holds the
      value the person typed, and offers the retry.
- [x] T068 [US3] Re-lay the editor as two columns on a wide screen and stacked on a narrow one —
      the task's own fields on one side, materials / accounts / tags on the other, attachments
      visible without scrolling. Accounts and tags moved out of the form to get there, which the
      form could afford because it no longer submits anything.
- [x] T069 [US3] Speak an attachment's availability in words in `TaskAttachmentTile.tsx`. It was
      said only in `data-availability` and a dimmed preview, so a file somebody had trashed looked
      exactly like one whose thumbnail was slow. The action that resolves it is the registry's:
      a trashed attachment offers Restore, which it already did.
- [x] T070 [US3] Guard the actions that cannot apply to a folder attachment. The registry
      already keeps file-only actions off a folder; what was left was Open, which raised a
      preview dialog with nothing to show. It goes into the folder now.
- [x] T071 [US3] Let a tag be created from `TaskLabelsEditor` and a member invited from the
      assignee control, without leaving the task. The word typed into the tag search becomes the
      tag and lands on the task in one press; the assignee field raises the existing
      `InvitationPanel` over the task rather than sending anyone to the settings.
- [x] T072 [US3] Make `revealAttachment` use the injected client rather than `teamApi` directly,
      and keep the task open behind the explorer. It no longer calls `onClose()` first: closing
      writes its own address, and the reveal's landed on top of it, so Back came out at the task
      list instead of the task.
- [x] T073 [US3] Move the progress-eye preference into `persistedView`. It had a key, a reader,
      a writer and an effect of its own — the same mechanism written twice, and the two disagreed
      about what happens when you switch spaces.
- [x] T074 [US3] Keep the sort control present when the space has no tags, explaining itself
      instead of vanishing — "order by tag" was a feature you could only find by already having
      used it.
- [x] T075 [US3] Add bulk actions to the board for what is safe in bulk — status, assignee, tag,
      delete — on the inventory's `SelectionBar`, from the same list a card uses
      (`useTaskActions.tsx`). **One deliberate difference**: the delete asks rather than promising
      an undo. A trashed file comes back because the Drive keeps it; a deleted task does not, and
      recreating one from what the board still holds would return a title and lose the
      attachments, the tags, the accounts and the progress. An undo that quietly does something
      else is worse than no undo, so the question names what goes with them (021, finding R3).
- [x] T076 [US3] Put the actions that do not need the editor on the task card behind one
      overflow, keeping the whole card as the open target. The overflow and the tick box stay at
      low contrast until the pointer or the keyboard is inside the card — on a board of fifty,
      a control that is always at full contrast is fifty distractions.
- [x] T077 [US3] Reduce the filter row to a search field, the date control and one "Filters"
      surface showing what is active as removable chips — `TaskFilterBar.tsx`. Thirteen controls
      became four. **One deliberate difference from the task as written**: status stays in the
      row rather than going behind "Filters", because "what is left" is the question a board
      answers and the four status pills read as one segmented control, not as four buttons. The
      quick ranges became presets inside the calendar. `taskScopeLabel` is shared so the pill and
      the chip cannot disagree about what the board is narrowed to.
- [x] T078 [US3] Update the task test files the change invalidates. Three tests in
      `creative-library-tasks` were turned inside out rather than deleted — what they protected
      (work must not be lost by closing a dialog) is still the point, it is just no longer
      protected by holding the work. `team-task-accounts`' date tests lost their Save press, and
      `team-explorer-capability-map` now names the route rather than the label that sat on it.
- [x] T079 [P] [US3] Write `tests/task-editor-autosave.test.tsx`: each field writes on change; no
      Save button exists; closing raises no prompt; a conflict offers the newer value.

**Checkpoint**: quickstart Checkpoint 4, items 1–4 and 6.

---

## Phase 6: User Story 4 — dates behave like a calendar (Priority: P2)

- [x] T080 [US4] Replace the hand-written calendar in `TaskDateFilter.tsx` with the inventory's
      `RangeCalendar`, quick ranges beside it as presets.
- [x] T081 [US4] Replace the hand-written calendar in `TaskDateField.tsx` with the inventory's
      `Calendar` — a picker rather than a `DatePicker`, because the trigger already reads as the
      date and a typed field beside it would be a second way to say the same thing.
- [x] T082 [US4] Decide the half-made range once — it is kept, not abandoned. React Aria commits
      only a finished range, and the popover no longer throws the first day away when it closes.
      Finding B4 of 021 is closed, and `tests/task-dates-one-calendar.test.tsx` holds it.
- [x] T083 [US4] Keep quick ranges stored by name so "today" stays today across a reload. Already
      true: `encodeDateFilter` writes `{kind:'quick', range}` and `parseStoredDateFilter` resolves
      it against the current day. Nothing to change — recorded so the next reader does not look
      for it twice.
- [x] T084 [US4] Delete the 42-button markup and its CSS. 1,761 characters of hand-built month
      out of `styles.css`, and the grid helpers (`monthDays`, `monthStart`, `calendarWeekdays`,
      two `Chevron` components) out of both date surfaces.
- [x] T085 [P] [US4] `tests/task-dates-one-calendar.test.tsx`: the locale's first day of week is
      respected (Sunday in en-US, Monday in uk-UA, in the reader's own words), PageDown moves by
      month and Shift+PageDown by year, a half-made range commits nothing and loses nothing, and
      neither date surface nor the stylesheet still carries a 42-cell month.

**Checkpoint**: quickstart Checkpoint 4, item 5.

---

## Phase 7: User Story 5 — one file, one identity (Priority: P2)

- [x] T086 [US5] Write `apps/web/src/team/materials/MaterialDetail.tsx` — preview, name, kind,
      size, modified, folder, colour tag, companions, and the full action list. The preview is
      supplied by the host: how a thumbnail is fetched genuinely differs (the explorer holds a
      session and render pointers, a task holds its own client), but everything a reader
      recognises the file *by* is in one place and one order.
- [x] T087 [US5] Use it in the explorer's detail pane, replacing `PreviewPane`'s bespoke layout.
      The catalog block went with it — "Product catalog" is in the action list and its dialog
      already offers the existing one — but **the text block stays, deliberately**: it is the one
      surface that can choose *which* text, the original or a translation. `copyText` is left
      unwired in `PaneActions` so the pane does not also offer a one-press copy that guesses.
      A menu item that guesses is right where there is no room to ask; here there is room.
- [ ] T088 [US5] Use it in search — the shell currently drops `has-pane` while searching; search
      keeps the surface. **Started and set down, with the reason.** The pane is fed a
      `TeamMaterialRow`, and a search result is a `CatalogMaterialItem` that genuinely lacks
      three of that shape's fields — `driveFileId`, `driveVersion`, `thumbnailReady` — so a
      conversion would have to invent them, and opening a folder from a search result would open
      the wrong thing. `MaterialDetail` (T086) is the way through: search should render the card
      from its own item rather than pretend to be a folder row. That also needs selection state
      for results, which they have never had. Worth doing; too much to do sideways while the
      pane, the shell split (T095) and the search list are all still moving.
- [ ] T089 [US5] Use it from a task attachment and from the updater's list.
- [x] T090 [US5] Give search results the thumbnail, the colour tag and the share action they lack.
      The tag and the share had already arrived with the shared action surface (T054); the
      picture is new. A file found by search showed a category glyph while the same file in a
      folder showed its thumbnail, so recognising it depended on how you had looked for it.
- [x] T091 [US5] Make opening a row consistent between list and grid, and give the row's name a
      real focusable control. One grammar in both views: a press selects, a second opens, and a
      folder opens on the first because there is no preview of a folder to wait for. The list
      needed two presses for a folder and the grid one — the same gesture meaning different
      things depending on which view you were in. The name is a control again, text-sized rather
      than the width of the cell: what 021 removed was a strip that swallowed every press aimed
      at the row, and what it removed with it was the only thing a keyboard could land on.
- [x] T092 [US5] Make the two selections visually distinct. Selected is where you are — one row,
      outlined; checked is what the next action reaches — any number, filled. Both were drawn as
      an accent outline, so a grid of forty checked tiles looked like forty cursors, and a
      checked row in the list looked like nothing at all until you found its tick. The
      out-of-view count was already there and already honest: it counts against the rows the
      shell holds, not the rows on screen.
- [ ] T093 [US5] Unify process / compress / transcript scope into one dialog that asks for the
      scope — this file, this folder, the selection, the whole space — instead of three doors.
- [x] T094 [US5] Remove the duplicated sort: the shell sorts, the views do not. Both sorted the
      same array with the same comparator on every render — two sorts that agreed by accident,
      and the day they stopped agreeing Down would have moved to a different row from the one
      below. The views still default to the page's own rows so either can be rendered alone.
- [x] T095 [US5] Split `apps/web/src/team/explorer/ExplorerShell.tsx` so that no file in the team
      tree holds upload, clipboard, queue, restitch, tags, keyboard and view state at once.
      2,240 lines → 1,935. Two concerns left whole rather than rewritten, because every comment
      in them records something learned the hard way:
      - `useAgentQueue.ts` (323 lines) — one queue for everything that runs on the local app.
        Transcribing and compressing are the same shape of job, and none of it needs to know
        what a folder row looks like. `deliberateStop` went with it, to its only caller.
      - `useExplorerClipboard.ts` — copy, cut and paste. Held in a ref, not state, because
        nothing on screen changes when you press ⌘C and re-rendering five hundred rows to
        remember four ids would be the most expensive thing a copy ever does.
      Upload, restitch, tags and the keyboard are still in the shell; they are more entangled
      with the folder listing than these two were, and T096 is the reason to come back.
- [x] T096 [US5] Make a 500-row folder usable without repeated manual paging (FR-044) —
      continuous loading, in `MorePages.tsx`. Five presses of "Show more" is not a page size; it
      is a page size somebody forgot to finish, and the search, the arrow keys and the batch
      scope all worked on whatever had been pressed into existence. The button stays: it is the
      fallback where there is no `IntersectionObserver`, it is what a keyboard reaches, and a
      sentinel that silently does nothing is indistinguishable from a list that has ended.
      **Deliberately not virtualised** — five hundred rows of plain markup is not what made this
      slow, the hundred-at-a-time fetching was, and windowing costs the browser's own
      find-on-page, which is how people actually look for a file in a long list. Findings B2 and
      B3 of 021 close with it.

**Checkpoint**: quickstart Checkpoint 5, items 1 and 5.

---

## Phase 8: User Story 6 — actions you can find without hunting (Priority: P2)

- [ ] T097 [US6] Write `apps/web/src/team/palette/WorkspacePalette.tsx` on the inventory's
      `Modal` + `SelectMenu` — grouped results, keyboard throughout.
- [ ] T098 [US6] Give the palette its data: materials through `searchCatalog`, tasks and accounts
      through their existing hooks, folders through the tree, spaces through the lobby list —
      debounced, cancellable, and never blocking the input.
- [ ] T099 [US6] Bind ⌘K / Ctrl+K at the workspace level and make the palette addressable by
      adding its field to `TeamRouteQuery` in `apps/web/src/team/routes.ts`, as settings and the
      updater already are.
- [ ] T100 [US6] Add the context menu to explorer rows and tiles, acting on the checked set when
      the pointer is over a checked row, and suppressing the browser menu only there.
- [ ] T101 [US6] Write `apps/web/src/team/palette/ShortcutSheet.tsx` from **one** shortcut
      registry that the bindings themselves read, so the sheet cannot drift from the product.
- [ ] T102 [US6] Name each shortcut in the tooltip of the control it duplicates.
- [ ] T103 [US6] Add copy / cut / paste as menu items, not only as keystrokes.
- [ ] T104 [US6] Make toolbars and selection bars collapse into a labelled overflow at narrow
      widths instead of becoming unlabelled icons.
- [ ] T105 [P] [US6] Test: the palette reaches every entity kind; the shortcut sheet lists every
      binding the registry holds.

**Checkpoint**: quickstart Checkpoint 5, items 2–4.

---

## Phase 9: User Story 7 — the chrome stops throwing you out (Priority: P2)

- [ ] T106 [US7] Make settings, the updater and the trash open over the current section —
      `apps/web/src/team/routes.ts` (which currently drops those params for non-explorer
      sections) and `apps/web/src/team/workspace/WorkspaceShell.tsx` — and return to it on close.
- [ ] T107 [US7] Make the trash reachable from every section.
- [ ] T108 [US7] Make Members one screen, and make every deep link land on the survivor.
- [ ] T109 [US7] Put "New space" in the space switcher.
- [ ] T110 [US7] Put leaving a space and transferring ownership in one place, each naming the
      other.
- [ ] T111 [US7] Make the dialogs worth restoring addressable — batch processing, material
      preview, storage detail — and leave the rest as component state.
- [ ] T112 [US7] Make the three header chips one component with one shape and one interaction,
      differing only in what they report; give the connection state a chip that can be pressed,
      instead of a `<span>` that announces a problem and offers nothing.
- [ ] T113 [US7] Make the toast provider reach every surface that can raise one.
- [ ] T114 [US7] Update `tests/team-routes*` and the shell tests for the new query fields and the
      section-preserving behaviour.
- [ ] T115 [P] [US7] Test: opening each of settings / updater / trash from each section returns
      to that section.

**Checkpoint**: quickstart Checkpoint 6, items 1–3.

---

## Phase 10: User Story 8 — accounts, agents and members (Priority: P3)

- [ ] T116 [US8] Rebuild `apps/web/src/team/accounts/AccountGroup.tsx` and `AgentRow.tsx` on the
      inventory's `Table` at its dense size, keeping the sticky header and the foldable money
      column, and ensuring no cell leaves its column when a group folds.
- [ ] T117 [US8] Delete the hand-rolled `AgentMenu` and its module-level "one menu open" global;
      row actions come from the shared menu.
- [ ] T118 [US8] Put `apps/web/src/team/accounts/AgentMoney.tsx` on `InputNumber`, with one money
      format and its currency, used everywhere money appears.
- [ ] T119 [US8] Put the occupancy chips, the marker filter and fold-all on `SegmentedControl` /
      `Chip` / `DisclosureGroup`; make the account head a real disclosure operable by keyboard.
- [ ] T120 [US8] Make identifiers selectable and copyable rather than living in a `title`.
- [ ] T121 [US8] Make every count pressable — a tag chip filters to what it counted, Free/Busy
      filters by that state, "N tasks" goes and comes back.
- [ ] T122 [US8] Make agent tags searchable and filterable in the accounts toolbar.
- [ ] T123 [US8] Link a task's agent chip back to that agent in Accounts.
- [ ] T124 [US8] Put members, permissions, ownership transfer and invitations on the inventory —
      `Table`, `Select`, `Checkbox`, `FormField` — replacing the raw selects and checkbox grids.
- [ ] T125 [US8] Make an invitation state its own state in words and offer only the actions that
      state allows.
- [ ] T126 [US8] Page the space history, which today stops at fifty with no way to ask for more.
- [ ] T127 [US8] Put the settings panels on the inventory —
      `workspace/TeamPreferencesSection.tsx` (which also stops failing silently),
      `product-catalog/ProductCatalogSettingsSection.tsx`, `labels/TaskLabelsSection.tsx`,
      `drive/DriveConnectionPanel.tsx`, `workspace/RestitchDefaultsSection.tsx`.
- [ ] T128 [US8] Make read-only actions available to anyone who may read.
- [ ] T129 [US8] Remove the `aria-controls` that names a list which is never hidden.
- [ ] T130 [US8] Update `scripts/check-accounts-layout.mjs` for the new markup. Its invariant —
      every run line's `scrollWidth` equals its cell's width, at both sides of 560 / 1000 / 1200 —
      is the right invariant and must keep holding; only the selectors change.

**Checkpoint**: quickstart Checkpoint 6, items 4–6.

---

## Phase 11: The catalog updater and the remaining surfaces

- [ ] T131 Put `apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx` on the inventory —
      `SearchField`, `Checkbox` with a real `indeterminate` prop, `ToggleButtonGroup` for the
      intervals, `NumberField` for the custom hours, and the shared row actions.
- [ ] T132 Link the updater to a catalog's video and back, which nothing does today.
- [ ] T133 Put `apps/web/src/team/product-catalog/CreateProductCatalogDialog.tsx` on `FormField`
      and `Input`, and give `ProductCatalogMenuDialog.tsx` a loading state instead of rendering
      nothing while it fetches.
- [ ] T134 Put the remaining dialogs and viewers on the inventory: `TeamCompressorDialog`,
      `FolderScopeDialog`, `UploadConflictDialog`, `ProcessMaterialDialog` (whose raw `<select>`
      of tool ids becomes a real choice), `ProcessLibraryDialog`, `BulkUploadDialog`,
      `CreateSpaceWizard`, `TrashView`, `TeamTextEditor`, `MaterialMetadataEditor`,
      `MaterialPreview`, `LandingFullView`.
- [ ] T135 Put the lobby, the space-state panel and the no-access screen on the inventory, and
      give the no-access terminus something to press.
- [ ] T136 Sweep `apps/web/src/i18n.ts`: every string this feature introduced exists in both
      languages, no key is English-only, and nothing was left as a literal in a component.

---

## Phase 12: Polish, deletion, and the sweep

- [ ] T137 Write `tests/team-raw-controls.test.ts` — zero raw `<button>`, `<input>`, `<select>`,
      `<textarea>` under `apps/web/src/team/` (SC-002). Run it; fix what it finds.
- [ ] T138 Delete `apps/web/src/styles/team-tasks.css` and `apps/web/src/styles/team-accounts.css`
      and every team rule the migration orphaned in `apps/web/src/styles.css` (SC-009); confirm
      `node scripts/verify-styles.mjs` and `tests/stylesheet-integrity.test.ts` pass.
- [ ] T139 Prove SC-010: assemble a screen the product does not have from the inventory alone,
      photograph it, delete it, and record whether it needed a new token or variant.
- [ ] T140 Walk every team screen at 390 px and 1440 px, in both themes, with reduced motion on
      and off; fix what the sweep finds; record the rest.
- [ ] T141 Check the one-primary-per-surface, no-colour-alone and empty/error/permission-pattern
      rules on every screen the sweep covers.
- [ ] T142 Run the accessibility gate; `a11y-baseline.json` must show no new violation.
- [ ] T143 Build, measure, and re-ratchet `performance-baseline.json` **once**, against T008's
      before-numbers, with a note naming both halves — the library added and the CSS deleted
      (SC-013).
- [ ] T144 Regenerate the CSP headers; `generate:csp:check` must report no drift.
- [ ] T145 Run `npx prettier --write apps packages tests scripts docs`, then `npm run lint` and
      the full gate list from quickstart.
- [ ] T146 Write `specs/024-heroui-workspace/findings.md` — what the migration walked past, what
      it taught the system, what it deliberately did not do, and what it weighed — in the shape
      feature 021's findings file established.
- [ ] T147 Confirm the feature is still web-only deployable: nothing changed under `apps/agent`,
      `packaging`, `packages/shared/src`, `packages/shared/package.json` or
      `config/production.env`.
- [ ] T148 Walk every quickstart checkpoint end to end on the beta, in one sitting, as a person
      doing real work — create a task, attach a video, catalogue it from the task, find it again
      by search, compress it from the palette — and fix whatever that walk makes obvious.

---

## Dependencies

```
Phase 1 (setup)  →  Phase 2 (foundation)  →  Phase 3 (US2, the inventory)
                                                    │
                    ┌───────────────────────────────┼───────────────────────────┐
                    ▼                               ▼                           ▼
          Phase 4 (US1, actions) ──→ Phase 5 (US3, tasks) ──→ Phase 6 (US4, dates)
                    │                               │
                    └──→ Phase 7 (US5, identity) ──→ Phase 8 (US6, discoverability)
                                                    │
                                Phase 9 (US7, chrome) ── Phase 10 (US8, accounts)
                                                    │
                                Phase 11 (remaining surfaces)
                                                    │
                                Phase 12 (polish, deletion, sweep)
```

- **Phase 3 blocks everything.** Nothing else can use a component that has not been swapped.
- **Phase 4 blocks Phases 5, 7, 8, 10 and 11**, because each renders the shared action surface.
- Phases 6, 9 and 10 are independent of one another once Phase 4 is done.
- Phase 12 is last by definition: it deletes what the earlier phases orphaned.

## Parallel opportunities

- T002, T003, T006, T007 during setup.
- T021–T024, T027 during the inventory swap — different files, no shared state.
- T061, T062, T063, T079, T085, T105, T115 — every test task is parallel to its siblings.
- Phases 9 and 10 can run beside each other.

## Implementation strategy

**MVP is Phase 3.** After it the product already looks like a different, better product, on one
component vocabulary, with no flow changed and nothing at risk — and it can be shipped alone.

**The feature's point is Phase 4.** It makes the owner's example work, and it pays for every
later phase, because each then renders one surface instead of writing its own.

Everything after is a sequence of self-contained improvements, each verifiable on the beta
against its checkpoint, each shippable, each leaving less bespoke code than it found.

---

## Review pass — what a second reading of this list added

The first draft was complete against the spec and incomplete against the repository. Eleven
tasks were added after re-reading the working tree, because each named work that would otherwise
have surfaced mid-implementation as a surprise:

| Added                      | Why it was missing                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T008, and T143's tie to it | The before-weight is unobtainable once Phase 3 lands, and T143 needs it.                                                                                                    |
| T012                       | React Aria portals to `body`; the product has a sixteen-rung z-ladder. Feature 023 already lost a confirmation dialog under a backdrop once.                                |
| T013                       | `@heroui/styles` ships its own base and scrollbar sheets that nobody had decided about.                                                                                     |
| T014                       | The library pulls `tw-animate-css`; the product's reduced-motion rule is absolute.                                                                                          |
| T029                       | Two dialog implementations, 38 call sites. The draft migrated one and left the other.                                                                                       |
| T036                       | `InstantTips`, `useAnchoredLayer` and `useCompactToolbar` are three bespoke solutions to problems React Aria solves; leaving them would keep two tooltip systems.           |
| T041                       | 73 of 113 DOM test files render components the swap changes. This is a large task hiding inside "the tests still pass".                                                     |
| T051                       | Moving an action's call site silently moves its analytics.                                                                                                                  |
| T078, T114, T130           | Three existing suites and one browser-measured gate are coupled to markup this feature rewrites — including `check-accounts-layout.mjs`, whose invariant must keep holding. |
| T096                       | FR-044 and quickstart Checkpoint 5 both require a 500-row folder to stay usable; no task delivered it.                                                                      |
| T098, T099                 | The palette had a component but no data sources and no address.                                                                                                             |
| T101                       | A hand-written shortcut list drifts; deriving the sheet from the bindings is the only version that stays true.                                                              |
| T136                       | A migration this size introduces strings everywhere; the compile-checked keys catch the missing ones only if someone sweeps.                                                |
