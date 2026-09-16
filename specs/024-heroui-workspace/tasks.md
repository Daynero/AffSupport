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
- **[Story]**: US1–US14 from the spec; setup and foundational tasks carry none

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

- [x] T043 [US1] **Superseded by T149**, which does the lift with its reason (US10). Lift the compression queue out of `apps/web/src/team/explorer/ExplorerShell.tsx`
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
      recognises the file _by_ is in one place and one order.
- [x] T087 [US5] Use it in the explorer's detail pane, replacing `PreviewPane`'s bespoke layout.
      The catalog block went with it — "Product catalog" is in the action list and its dialog
      already offers the existing one — but **the text block stays, deliberately**: it is the one
      surface that can choose _which_ text, the original or a translation. `copyText` is left
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
      in them records something learned the hard way: - `useAgentQueue.ts` (323 lines) — one queue for everything that runs on the local app.
      Transcribing and compressing are the same shape of job, and none of it needs to know
      what a folder row looks like. `deliberateStop` went with it, to its only caller. - `useExplorerClipboard.ts` — copy, cut and paste. Held in a ref, not state, because
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

- [x] T097 [US6] Write `apps/web/src/team/palette/WorkspacePalette.tsx` — grouped results,
      keyboard throughout. On `Modal` plus a listbox: the inventory has no `SelectMenu`, and a
      combobox over four kinds of thing is not a select. The arrows walk the whole list across
      group boundaries, because a person typing three letters is not thinking in sections.
- [x] T098 [US6] Give the palette its data — `usePaletteResults.ts`. The three small lists
      (folders, tasks, accounts) are read once when it opens and filtered on every keystroke;
      files stay a search, debounced, with a late answer to a question nobody is asking any more
      dropped rather than rendered. The field never waits and the list never empties itself
      mid-search: a list that blinks is a list that makes you stop typing. Spaces are not in it —
      the palette is scoped to the space it is opened in, and switching spaces is the lobby's.
- [x] T099 [US6] Bind ⌘K / Ctrl+K at the workspace level and make the palette addressable.
      Verified in the beta. One defect found and fixed there: the palette and every result are
      both writes to the address, and running the result before closing put the destination in
      the history and then the close put the old address straight back on top — Enter appeared
      to do nothing at all.
- [x] T100 [US6] Add the context menu to explorer rows and tiles, suppressing the browser menu
      only there — a right-click on the page, on a link or on selected text still belongs to the
      browser. It opens the registry's own list, not a second shorter one: a context menu that
      knows fewer things than the "…" beside it is a context menu people stop using. **The
      checked-set half is not done**: acting on a selection needs the `selection` host resolved
      over many materials, which is T058, still open.
- [x] T101 [US6] Write `ShortcutSheet.tsx` from one registry (`shortcuts.ts`) that the bindings
      read. `formatShortcut` lives beside the table so a tooltip and the sheet spell a chord the
      same way, and `matches` is written once so no call site re-derives what "⌘" means.
- [x] T102 [US6] Name each shortcut in the tooltip of the control it duplicates — from
      `formatShortcut`, so the tooltip and the sheet spell a chord the same way. Only the search
      control duplicates one today; the rest of the registry's bindings have no button.
- [x] T103 [US6] Add copy / cut / paste as menu items, not only as keystrokes — they existed
      only as ⌘C/⌘X/⌘V, which means they existed only for whoever had read the code. Explorer
      hosts only: a paste lands in _the folder you are looking at_, and a task or a search result
      is not a place. The registry's own rule caught the consequence — nine items under one
      heading — so `organise` split into **organise** (what it is called) and **place** (where it
      goes), which is a better taxonomy than the one it replaced.
- [ ] T104 [US6] Make toolbars and selection bars collapse into a labelled overflow at narrow
      widths instead of becoming unlabelled icons.
- [x] T105 [P] [US6] `tests/workspace-palette.test.tsx`: the palette reaches a file, a folder, a
      task and an account from one field; it never empties while a search is in flight; the
      arrows wrap across groups; the sheet lists every binding the registry holds and nothing
      else; and a chord matches only itself — a binding that fires with extra modifiers held is
      a binding that fires when you meant something else.

**Checkpoint**: quickstart Checkpoint 5, items 2–4.

---

## Phase 9: User Story 7 — the chrome stops throwing you out (Priority: P2)

- [x] T106 [US7] Make settings, the updater and the trash open over the current section —
      `apps/web/src/team/routes.ts` wrote those params only on an explorer address, and the
      shell's route builder forced `section: 'explorer'` on top of that. Both now carry the open
      section (and its task / agent / account) underneath the surface, so closing one lands
      exactly where it was opened. The palette rides the same way.
- [x] T107 [US7] Make the trash reachable from every section — the link is no longer
      explorer-only, and the explorer (hidden, not unmounted) is shown wherever `trash=1` is
      asked for, which is where a file deleted from a task actually went.
- [x] T108 [US7] Make Members one screen, and make every deep link land on the survivor. The
      settings dialog's "People" tab was the Members section again; it is gone, and
      `?settings=1&tab=members` parses to the Members section. The task assignee filter's empty
      state, the one in-product link to the old tab, points at the section.
- [x] T109 [US7] Put "New space" in the space switcher. The wizard now has an address,
      `/team?new=1`, which the resolver holds instead of entering a space underneath it;
      cancelling goes back to where it was opened, creating replaces the wizard in history.
- [x] T110 [US7] Put leaving a space and transferring ownership in one place, each naming the
      other. Leaving was in the settings' General tab and transferring on a member's row — after
      T108 two different screens. `LeaveSpacePanel` moved to `members/` and sits under the
      Members list; the owner's explanation points at the list above it, and the transfer
      dialog says where leaving is.
- [x] T111 [US7] Make the dialogs worth restoring addressable — batch processing, material
      preview, storage detail — and leave the rest as component state. The preview is
      `item=<id>&open=1`, restored by the explorer's existing reveal (it is the one that can find
      the row); `open` is dropped without an `item`. `process=1` is the **whole-space** batch
      only: a batch over picked files stays state, because the pick is not in the address and a
      restored window about nothing is worse than none. `storage=1` holds the Drive detail.
      Opening pushes; closing replaces, so Back after a close does not reopen it.
- [x] T112 [US7] Make the three header chips one component with one shape and one interaction,
      differing only in what they report; give the connection state a chip that can be pressed,
      instead of a `<span>` that announces a problem and offers nothing. There were four, not
      three — storage, the updater, background work, the connection — and all four are now
      `workspace/WorkspaceChip.tsx`. The waiting connection chip reloads the space; the disabled
      one stays a status, because there is nothing a reader can do about it.
- [x] T113 [US7] Make the toast provider reach every surface that can raise one. Every
      `useToasts` caller already sat under a provider; what did not reach was the _region_. It
      rendered inside the page's `<main>` while dialogs are portalled to the body, so its
      `--layer-toast` counted only inside the page's stacking context, and the dialog focus trap
      cycled through the dialog alone — a dialog's own Undo was a mouse-only control while the
      dialog was up. The region is portalled to the body and always mounted (a live region that
      appears with its first message is announced late or not at all), and the trap steps into
      the toasts. `tests/toast-reach.test.tsx`.
- [x] T114 [US7] Update `tests/team-routes*` and the shell tests for the new query fields and the
      section-preserving behaviour — routes for every surface over every section, the settings
      link to members, the wizard address and `open`/`process`/`storage`;
      `tests/team-workspace.test.tsx` for the preview writing and clearing `open`;
      `tests/team-entry-create.test.ts` for the resolver holding the wizard address.
- [x] T115 [P] [US7] Test: opening each of settings / updater / trash from each section returns
      to that section — in `tests/team-routes.test.ts`, with the palette as a fourth surface.
      The 023 assertion that pinned the updater to the explorer was the old promise, rewritten.

**Checkpoint**: quickstart Checkpoint 6, items 1–3.

---

## Phase 9A: User Story 10 — the performer's loop closes inside the task (Priority: P1)

**Goal**: everything the product makes from a video can be made from its attachment on a task,
and what is made comes back onto the task. Plan F1–F5.

**Independent Test**: on a task with a video, make its catalog, start its transcript and its
processed copy from the attachment, and see all three on the task without it closing.

- [x] T149 [US10] Create `apps/web/src/team/processing/AgentQueueProvider.tsx` that calls
      `useAgentQueue` once for the space; mount it in `WorkspaceShell.tsx` inside
      `LibraryProcessingProvider`; make `ExplorerShell.tsx` read the queue from context instead of
      calling the hook. Supersedes T043.
- [x] T150 [US10] Add `attachTo?: { taskId: string }` to `AgentQueueItem` and to
      `enqueueTranscriptions`; on a finished item with a material id, attach it through
      `attachTaskMaterials` — silent on `alreadyAttached` and on a missing task, one toast with
      **Take off** (detach) on success.
- [x] T151 [US10] Give `MaterialProcessFlow` an `onFinished(materialId)` prop, called from the
      outcome that already carries `outcome.materialId`.
- [x] T152 [US10] **Reversed on reading the contract**: `compress` was always meant to enqueue on a space-level queue, and T149 made one. It is kept and wired (Files rows, task attachments) through the compressor dialog, whose job building moved to `compressJobs`. Original text: delete the registry's standalone `compress` action (no handler anywhere; the
      compressor is a tool of `process`) and its strings; update the registry tests.
- [x] T153 [US10] Wire `transcribe`, `process`, `copyText` and `editText` in
      `TaskAttachmentTile.tsx` / `TaskEditor.tsx`: transcribe enqueues with `attachTo`; process
      opens `MaterialProcessFlow` nested over the task with `onFinished` attaching; transcripts
      get copy and edit. Nothing closes the editor. The catalog dialog is given `onCreated` /
      `onChanged`, so the attachment's companions refresh and the new catalog shows on the tile
      with Open and Copy link (US10 scenario 3) — today the tile never hears about it.
- [x] T154 [US10] Cap a task attachment tile at **2** inline actions plus "…" (a `maxInline`
      option on `useMaterialActionList`), so a card in a grid carries open and its primary make.
- [x] T155 [US10] Re-stitch and catalog settings links in the editor open settings over the task
      (`settings=1&tab=restitch|product-catalog`, `task` kept) instead of closing it for Files.
- [x] T156 [US10] "Show in folder" from a task writes `back=<taskId>`; `routes.ts` carries
      `back` on explorer addresses; Files' toolbar shows a return chip while it is present; any
      other Files navigation drops it.
- [x] T157 [US10] Route the tile's download through the shared download handler the explorer
      host uses, so a refusal is said in words and the local app is offered where it can take it.
- [x] T158 [P] [US10] Tests: `tests/task-attachment-make.test.tsx` — the video tile offers
      catalog, transcript and process; a finished queue item with `attachTo` attaches once and
      toasts; `alreadyAttached` is silent; settings open with `task` still in the address;
      `back` round-trips in `tests/team-routes.test.ts`.

**Checkpoint**: Journey A in the spec, end to end on the beta.

---

## Phase 9B: User Story 11 — the lead hands work over in one motion (Priority: P1)

- [x] T159 [US11] Write `apps/web/src/team/tasks/AddToTaskDialog.tsx`: a search field over the
      space's tasks, most recently changed first, keyboard-first (arrows, Enter), attaching the
      given material ids and reporting attached / already there / rejected in one toast that
      names the task and opens it.
- [x] T160 [US11] Add the registry action `addToTask` (in **organise**, beside create-task: the same question, which task is this file for, with two answers — not **place**) for materials and wire it
      in Files rows and tiles, the detail pane and search results; add it to the selection bar.
      It never changes section.
- [x] T161 [P] [US11] Test: `tests/add-to-task.test.tsx` (the dialog is provided space-wide by `AddToTaskProvider`, so rows, the pane, search results and the selection bar call one hook rather than threading a prop) — search narrows, Enter attaches the
      selection, "already attached" is information, and the address does not change.

---

## Phase 9C: User Story 12 — a task reads as a brief (Priority: P1)

- [x] T162 [US12] Make `.team-task-editor` an inline-size container and lay it out by container
      query: two columns (brief | work) at ≥ 820 px, one column below; the dialog grows to `xl`.
- [x] T163 [US12] Reorder the editor: title; one facts row (status · assignee · date); the brief
      with `field-sizing: content` and a three-row minimum; one compact progress row (slider +
      maximum + save-as-default with a label); right column materials → accounts → tags.
- [x] T164 [US12] `TaskStatusControl`: segmented form and `Select` form, one shown by container
      query; labels never wrap.
- [x] T165 [US12] **Undo withdrawn (021 R3): confirms instead.** The heading's menu holds Delete; the assignee's invite became the select's last option. Original: Replace the "Task details" heading with the save state and an editor menu
      holding Delete; deleting closes the editor and offers Undo that re-creates the task with its
      fields and attachments. Remove the mid-form delete button.
- [x] T166 [US12] Fold the attachments hint paragraph into the drop zone's own text.
- [x] T167 [P] [US12] Test: `tests/task-editor-layout.test.tsx` — order of sections, no Delete
      button outside the menu, Undo re-creates, the status select exists for narrow containers.

---

## Phase 9D: User Story 14 — calm at rest (Priority: P1)

- [x] T168 [US14] Files: `has-pane` and the pane only while something is selected.
- [x] T169 [US14] Rows and tiles: remove `ShareButton`; the "opens in Google Drive" note becomes
      an icon with a tooltip; folder tiles drop the "Folder" caption and take a compact size.
- [x] T170 [US14] Header — and, found on the beta, the name, tabs and utilities put on one panel of their own ground, because the tabs vanished over a lit hexagon exactly as the links had: remove the eyebrow; one "Space" `DropdownMenu` (trash, catalog
      updater, settings, shortcuts); a palette trigger with `⌘K` in its tooltip; storage chip
      only for non-healthy states; updater chip only while running.
- [x] T171 [US14] Board and Accounts: hide the heading's primary action while the empty state
      carries it; Accounts hides its toolbar at zero accounts; the board's filter count badge goes
      (the chips state what is active); the progress toggle gets a visible label.
- [x] T172 [US14] Members: one heading (drop `MembersSection`'s duplicate); a member row keeps
      Edit and moves Remove and Transfer into a "…" menu.
- [x] T173 [US14] Detail pane: do not wire `transcribe` in `PaneActions` while `VideoTextActions`
      is shown.
- [x] T174 [P] [US14] Test: `tests/workspace-at-rest.test.tsx` — the empty board, empty accounts,
      Files at rest and the header each have at most one primary action and no two controls with
      the same accessible name.

---

## Phase 9E: User Story 13 — solo is not a smaller team (Priority: P2)

- [x] T175 [US13] `solo = members.length <= 1` from the loaded member list; hide the assignee
      select, the invite button and the assignee filter while solo; they appear live with a
      second member.
- [x] T176 [US13] Board quick-add: a field in the board heading; Enter creates a task with that
      title, does not open the editor, clears, keeps focus.
- [x] T177 [P] [US13] Test (written into `tests/workspace-at-rest.test.tsx`, beside T174's): `tests/task-solo.test.tsx` — no assignee/invite controls with one
      member, present with two; quick-add creates three tasks by typing.

---

## Phase 9F: Walk it

- [x] T178 Walk journeys A–D on the beta at 1440 px and 390 px in both themes; fix what does not
      read or does not work; record each fix in `findings.md`.

---

## Phase 9G: User Story 15 — catalog variations (Priority: P1)

- [x] T179 [US15] Migration `20260916160000_product_catalog_variations.sql`: `variant` on
      `team_product_catalogs` (existing rows = 1); the one-live-companion index narrowed to
      transcripts; `list_material_product_catalogs`; `service_next_product_catalog_variant`;
      `service_link_product_catalog_companion` links a new variation beside the others and a
      re-create retires only what it replaces. ROLLBACK.md entry.
- [x] T180 [P] [US15] SQL tests: two variations live at once; numbers never reused after a
      removal; re-create keeps the number and retires only its own sheet; a stale re-create loses.
- [x] T181 [US15] Edge function: no "exists" refusal on create; `productCatalogName(video, N)` →
      `<stem>_v<N>_catalog`; a re-create keeps N; handler tests updated.
- [x] T182 [US15] Web API: `listProductCatalogs`, `variant` on the summary; companions carry the
      list; tail renames every variation with its own number.
- [x] T183 [US15] `ProductCatalogMenuDialog` becomes the video's catalog list (copy name, copy
      link, open; re-create and remove in the row menu; New variation); the result view shows the
      name with a copy button.
- [x] T184 [US15] Task tile: "Catalog" inline on a video; the updater names rows by catalog name.
- [x] T185 [P] [US15] Component tests for the list, the result's copy name, and the tile.
- [x] T186 [US15] Walk it on the beta: two variations from a task, copy names, remove one, restore
      it from the trash. (Walked: v1 and v2 from a task's tile, list, remove v2. Restore is held by
      the SQL test; not walked, to leave the owner's Drive trash alone.)

## Phase 9H: User Story 17 — a note on a file (Priority: P2)

- [x] T187 [US17] Migration `20260916220000_material_notes.sql`: `team_materials.note`, searched;
      `update_material_metadata` accepts `note`; `get_team_material_note`. `20260916230000` returns
      the note in search results. SQL tests for trim, line breaks, limit, removal, search.
- [x] T188 [US17] Shared patch normalizer and web API (`getMaterialNote`, `setMaterialNote`).
- [x] T189 [US17] `MaterialNoteBlock` in the details card, `MaterialNoteDialog` behind the registry's
      "Note" action, one note store so a save anywhere shows everywhere; the note in search results.
- [x] T190 [P] [US17] Component tests; walked on the beta (add in the card, open from the row menu,
      find by a word of it).

— accounts, agents and members (Priority: P3)

- [ ] T116 [US8] Rebuild `apps/web/src/team/accounts/AccountGroup.tsx` and `AgentRow.tsx` on the
      inventory's `Table` at its dense size, keeping the sticky header and the foldable money
      column, and ensuring no cell leaves its column when a group folds.
      **Target from the at-rest table (US14):** an agent row carries identity, state, run, money,
      one primary action and "…"; Copy ID and run edit/delete go into the menu; "Balance / Top-up"
      captions appear once, in the column header; the account head's rename/delete go into "…".
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
- [x] T125 [US8] (benchmark round 8: pending/accepted/declined/revoked/expired each a word; resend and revoke in one menu only while pending) Make an invitation state its own state in words and offer only the actions that
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

- [ ] T131 (rows and schedule done in benchmark round 3; the dialog's own controls onto the inventory still open) Put `apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx` on the inventory —
      `SearchField`, `Checkbox` with a real `indeterminate` prop, `ToggleButtonGroup` for the
      intervals, `NumberField` for the custom hours, and the shared row actions.
      **Target from the at-rest table (US14):** "…" per row instead of four icon buttons; two facts
      on the meta line; the footer's three notes behind one hint.
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
- [ ] T147 Confirm nothing changed under `apps/agent`, `packaging`, `packages/shared/src`,
      `packages/shared/package.json` or `config/production.env`. No longer web-only: US15 and the
      space's task maximum add migrations and an edge-function change, which deploy with it.
      Was: Confirm the feature is still web-only deployable: nothing changed under `apps/agent`,
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
