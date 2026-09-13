---

description: "Task list for 021-design-system-redesign"
---

# Tasks: One Design System Across Every Screen

**Input**: Design documents from `/specs/021-design-system-redesign/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Included. The spec asks for mechanical verification (SC-002, SC-003, SC-005,
SC-006, SC-010) that prose cannot provide, and FR-038 forbids weakening the existing suite —
so token, component and screen tests are part of the work, not optional extras.

**Organization**: Phase 2 is the token layer and Phase 3 the inventory; both block
everything. Phases 4–17 are the fourteen screen groups — each independently shippable, each
carrying its own state (US2), motion (US3) and width/theme (US4) verification. Phases 18–20
are the whole-product passes that only make sense once every group has landed.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: US1 one vocabulary · US2 every state designed · US3 motion · US4 widths and
  themes · US5 cheap to build on
- Paths are repository-relative

## Path Conventions

Web app only: `apps/web/src/**`, `tests/**`, `scripts/**`, `docs/**`.

---

## Phase 1: Setup

**Purpose**: The places the system will live.

- [x] T001 Create `apps/web/src/styles/tokens.css`, `apps/web/src/styles/base.css` and `apps/web/src/styles/components.css` as empty modules imported from `apps/web/src/styles.css` (import order: tokens → base → components → existing modules → existing screen rules)
- [x] T002 [P] Create `apps/web/src/components/ui/index.ts` and make `apps/web/src/components/ui.tsx` re-export from it, so the ~60 existing `from '../components/ui'` imports keep working unchanged
- [x] T003 [P] Put both design documents on the contributor path: add a "Design system" section to `README.md` and `AGENTS.md` pointing at `docs/DESIGN.md` (product rules, first authority), `docs/DESIGN-PRINCIPLES.md` (craft reference) and `specs/021-design-system-redesign/contracts/`

---

## Phase 2: Foundational — the token layer (BLOCKS EVERYTHING)

**Purpose**: One source for every colour, type step, space, radius, shadow, duration and
layer, adopted by the existing stylesheet so unmigrated screens inherit it untouched.

**Completion gate**: `node scripts/check-design-tokens.mjs` and
`npx vitest run tests/design-tokens.test.ts` both pass; the product looks unchanged except
where a value was already out of contract.

- [x] T004 Write the seven colour roles (`primary`, `secondary`, `success`, `info`, `warning`, `error`, `neutral`) with their full shade sets for both themes into `apps/web/src/styles/tokens.css`, per `contracts/tokens.md`; keep `--purple-*` / `--honey-*` as the private palette the roles are built from
- [x] T005 Write the type ramp (`--text-display` … `--text-micro`) with weights and line heights into `apps/web/src/styles/tokens.css`, keeping the current step values so no screen resizes
- [x] T006 [P] Write the space, radius, shadow and layer sets into `apps/web/src/styles/tokens.css`, documenting the 2× radius-nesting rule from `docs/DESIGN-PRINCIPLES.md`
- [x] T007 [US3] Write the motion set into `apps/web/src/styles/tokens.css`: `--motion-fast: 150ms`, `--motion-base: 220ms`, `--motion-slow: 300ms`, `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`, `--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)`, plus the `prefers-reduced-motion` block that collapses all three durations to 1ms
- [x] T008 Redefine every legacy custom property in `apps/web/src/styles.css` as an alias of a token (`--color-accent*` → primary, `--color-action*` → secondary, `--color-surface*`/`--color-text*` → neutral, `--text-2xs…--text-17xl` → the nearest ramp step, `--dur-*` → motion with anything over 300ms snapping to `--motion-slow`, `--ease-*` → the two curves); delete the now-duplicate definitions
- [x] T009 Move the global reset, element defaults and the single focus-visible treatment out of `apps/web/src/styles.css` into `apps/web/src/styles/base.css`
- [x] T010 [P] Write `scripts/check-design-tokens.mjs`: fail on a hex/`rgb()`/`hsl()` literal, a `ms`/`s` duration, a `px` radius or a `rem` font-size outside `styles/tokens.css`, and on a `transition` naming a property other than `transform`, `opacity`, `filter`, `color`, `background-color`, `border-color`, `box-shadow`; report file, line and the token to use instead
- [x] T011 Wire `scripts/check-design-tokens.mjs` into `npm run verify` in `package.json`, with an allow-list file for the exemptions that exist at the moment it lands (the list must shrink to empty by T151)
- [x] T012 [P] [US4] Write `tests/design-tokens.test.ts`: every token has a value in both themes; every declared foreground/background pair in `contracts/tokens.md` meets WCAG AA (4.5:1 text, 3:1 large and non-text); no duration exceeds 300ms
- [ ] T013 Run the beta and walk five screens (compressor, transcription, explorer, tasks, settings) confirming the alias layer changed nothing except out-of-contract durations; record anything that moved in `specs/021-design-system-redesign/findings.md`

**Checkpoint**: the system exists and the whole product is already reading from it.

---

## Phase 3: [US5] The component inventory (BLOCKS ALL SCREEN GROUPS)

**Goal**: 45 named components, every variant × size × state, demonstrable on one page.

**Independent test**: open `/design` — every component, variant, size and state is visible;
building a new screen from them needs no new token.

- [x] T014 [US5] Implement Button and IconButton in `apps/web/src/components/ui/Button.tsx`: six variants × five sizes × seven colours, plus `loading`, `disabled`, `block`, `square`, leading/trailing icon, and the `:active` 0.97 scale (excluded under reduced motion)
- [x] T015 [P] [US5] Implement Badge and Chip in `apps/web/src/components/ui/Badge.tsx`, including the removable and selected chip states
- [x] T016 [P] [US5] Implement Card (surface/panel/section roles) and Separator in `apps/web/src/components/ui/Card.tsx`
- [x] T017 [P] [US5] Implement Alert in `apps/web/src/components/ui/Alert.tsx` with the five semantic colours and soft/subtle/outline variants
- [x] T018 [US5] Implement FormField, Input, InputNumber, Textarea and Select in `apps/web/src/components/ui/Field.tsx`, with label/help/error/required anatomy and the rest/focus/disabled/invalid states
- [x] T019 [US5] Implement Checkbox, RadioGroup (list/cards/pictos), Switch, Slider and SegmentedControl in `apps/web/src/components/ui/Choice.tsx`
- [x] T020 [P] [US5] Implement SelectMenu and InputTags in `apps/web/src/components/ui/Field.tsx` (search, multiple, empty state)
- [x] T021 [US2] [US5] Implement Empty, Skeleton and Progress in `apps/web/src/components/ui/Feedback.tsx` — Empty takes icon, title, one sentence and an optional action; Skeleton takes the shape of what is coming (text, block, row, tile)
- [x] T022 [US5] Implement Modal, Drawer, Popover, DropdownMenu and ContextMenu in `apps/web/src/components/ui/Overlay.tsx`, with focus trap, restore-on-close, and the 0.95→1 scale from the trigger's origin
- [x] T023 [US5] Re-home `apps/web/src/components/Modal.tsx` and `apps/web/src/components/toast.tsx` onto Overlay and Feedback without changing their public API
- [x] T024 [P] [US5] Implement Tooltip with a delay group (delay on the first of a group, none on its neighbours) in `apps/web/src/components/ui/Feedback.tsx`
- [x] T025 [P] [US5] Implement Tabs, Breadcrumb, Link and Pagination in `apps/web/src/components/ui/Navigation.tsx`
- [x] T026 [US5] Implement Table (header, row, cell, `xs`/`sm` density, sticky header, selectable, row actions), Accordion, Tree, Timeline and User in `apps/web/src/components/ui/Table.tsx`
- [ ] T027 [US5] Bring the twelve product-specific components onto tokens and the state rules without changing behaviour — DropZone, HoneycombField, PowerLever/PowerReadout/PowerThrottle, the CRF pixel gem, JobRow, TranscriptPlayer, TaskProgressScale, LandingGalleryGrid, StorageChip, Marked, CodeCell/Countdown, the SotyLoader family — and record each one's anatomy in `contracts/components.md`
- [x] T161 [US5] Encode the rules already in `docs/DESIGN.md` into the inventory so that using a component *is* following them (FR-040): lucide at `ICON_SIZE`/`ICON_STROKE` with "grow the plate, never shrink the icon"; the picto-group RadioGroup variant with `is-selected` (never `is-active`), 44×38 plates, `is-labeled` for short values, `is-single` for a lone toggle; inline fields with the unit outside the border at 72–150px; validation shown only after invalid input; 30×30 icon plates on tiles; red destructive / green positive. Record each mapping in `contracts/components.md`
- [x] T028 [US2] [US5] Implement the five shared patterns on top of the inventory in `apps/web/src/components/ui/patterns.tsx`: empty state, loading state, error state, permission-limited state, confirmation dialog (verb button, de-emphasised destructive action, undo where the action can be undone)
- [x] T029 [US5] Write the inventory's styles into `apps/web/src/styles/components.css`, one section per component family, reading only from tokens
- [x] T030 [US5] Build the demo surface at `apps/web/src/dev/DesignSystemPage.tsx` and route `/design` to it behind a development-only guard; show every component × variant × size × state, with theme and reduced-motion toggles
- [x] T031 [P] [US5] Write `tests/ui-components.test.tsx`: each component renders each variant and size; icon-only controls expose an accessible name; every state a component declares (rest, hover, active, focus-visible, disabled, loading, selected, invalid) is distinct from every other, asserted through the class or attribute that carries it; every interactive component is keyboard operable and shows focus (FR-010, FR-011, FR-012)
- [x] T032 [P] [US5] Add a build check to `tests/` (or `scripts/check-design-tokens.mjs`) asserting `DesignSystemPage` is absent from a production bundle
- [x] T156 [P] [US1] [US5] Write `tests/ui-consistency.test.tsx`: render the same role (primary button, secondary button, destructive button, chip, field, panel heading) as each screen group will use it and assert the computed height, radius, font-size and icon size match — the mechanical half of SC-003, which prose review cannot give

**Checkpoint**: screens can now be migrated in any order.

---

## Phase 4: [US1] C1 — Entry and system states

**Goal**: the first twelve surfaces a person can meet, in one voice.

**Independent test**: sign out, sign in, break the config, block the account — each surface
states what is true, what to do, and looks like the same product.

- [x] T033 [US1] Migrate `apps/web/src/auth/AuthScreens.tsx` — LoginPage (Google primary, beta account secondary; fix the four-line wrap on the beta button), AuthCallbackPage, AuthHandoffPage
- [x] T034 [US1] [US2] Migrate the system states in `apps/web/src/auth/AuthScreens.tsx` — AuthLoadingScreen, AuthRecoveryScreen, BlockedAccountScreen (blocked and deleted), ConfigErrorScreen — onto the Empty/Alert patterns with title, one sentence and the way out
- [ ] T035 [P] [US1] Migrate `apps/web/src/PublicHomePage.tsx` — CTA above the fold, consistent header buttons, 70ch measure
- [x] T036 [P] [US1] Migrate `apps/web/src/pages/LegalPages.tsx` — measure cap, heading ramp, link styling
- [x] T037 [US1] Migrate ProfileOnboarding in `apps/web/src/auth/AuthScreens.tsx` onto Modal + RadioGroup (cards) + Checkbox + Button
- [ ] T038 [US1] Update the tests that assert on class names in `tests/auth-provider.test.tsx`, `tests/onboarding-recovery.test.tsx` and `tests/session-handoff-screens.test.tsx` to assert through roles and accessible names
- [ ] T039 [US1] [US4] Verify C1 at 1920/1440/1024/768/390 × dark/light × reduced motion with Ukrainian strings; delete the CSS these screens no longer need from `apps/web/src/styles.css`

---

## Phase 5: [US1] C2 — Shell and cross-cutting surfaces

**Goal**: the frame every screen sits in, and the surfaces that appear over all of them.

**Independent test**: every route shows the same top bar behaviour; a toast, a modal and a
tooltip look and move the same wherever they are raised.

- [ ] T040 [US1] Migrate the top bar in `apps/web/src/ProtectedSoty.tsx` and its controls — `SotyLogo`, `EnvironmentBadge`, `ThemeToggle`, `LanguageSwitch`, `UserAvatar`, `UserMenu` — onto Button/Badge/DropdownMenu
- [ ] T041 [US1] Migrate `apps/web/src/components/SupportDialog.tsx` (trigger chip + dialog) onto Badge + Modal + Progress
- [x] T042 [P] [US1] Migrate `apps/web/src/components/ReleaseUpdateNotice.tsx` onto Alert + Button
- [x] T043 [P] [US1] [US2] Migrate `apps/web/src/components/LocalAppDialog.tsx` and `apps/web/src/components/FeatureLockDialog.tsx` — the single "needs the local app" state, one anatomy for all six tools
- [x] T044 [P] [US1] Migrate `apps/web/src/components/InstantTips.tsx` and `apps/web/src/components/LabeledSkeleton.tsx` onto Tooltip and Skeleton
- [ ] T045 [US1] Update `tests/local-app-dialog.test.tsx`, `tests/local-app-dialog-windows.test.tsx`, `tests/release-update-notice.test.tsx` and `tests/loading-skeletons.test.tsx` to assert through roles
- [ ] T046 [US1] [US4] Verify C2 across three unrelated routes at five widths × two themes × reduced motion; delete the orphaned shell CSS

---

## Phase 6: [US1] C3 — Tools home and compressor

**Goal**: the product's front door and its most-used tool.

**Independent test**: drop files, change every setting, run a batch, hit an error — all of it
in inventory components, with the compressor looking exactly as good as it does today.

- [x] T047 [US1] Migrate `apps/web/src/HomePage.tsx` — tool cards onto Card + Badge + Button, including the "in development" state
- [ ] T048 [US1] Migrate `apps/web/src/components/SettingsPanel.tsx` onto Card + Collapsible + FormField + Choice, keeping the summary-in-the-heading behaviour
- [ ] T049 [US1] Migrate the compressor shell in `apps/web/src/App.tsx` — drop zone, batch toolbar, selection bar with its count, results summary
- [ ] T050 [P] [US1] Migrate `apps/web/src/components/JobRow.tsx` and `apps/web/src/components/ImageEmbeddingSection.tsx` onto Table row + Progress + Badge + Alert
- [ ] T051 [P] [US1] Migrate `apps/web/src/team/explorer/TeamCompressorDialog.tsx` onto Modal + the migrated settings panel
- [ ] T052 [US1] [US2] Give the compressor its full state set: initial, empty queue, running, partially failed, failed, agent-missing — each on the shared patterns
- [ ] T053 [US1] [US4] Verify C3 at five widths × two themes × reduced motion; delete the compressor's orphaned CSS

---

## Phase 7: [US1] C4 — Stitcher and landing optimizer

- [ ] T054 [US1] Migrate `apps/web/src/stitcher/StitcherPage.tsx` onto the inventory, reusing the compressor's drop zone, settings panel and toolbar
- [ ] T055 [US1] Migrate `apps/web/src/landing/LandingOptimizerPage.tsx` and `apps/web/src/landing/LandingJobCard.tsx`
- [ ] T056 [P] [US1] Migrate `apps/web/src/landing/ImageCompareModal.tsx` onto Modal, keeping the before/after comparison
- [ ] T057 [US1] [US2] Give both tools their full state set on the shared patterns, including the single agent-missing state
- [ ] T058 [US1] [US4] Verify C4 at five widths × two themes × reduced motion; delete orphaned CSS

---

## Phase 8: [US1] C5 — Transcription

- [ ] T059 [US1] Migrate `apps/web/src/transcription/TranscriptionPage.tsx` — intake, toolbar, selection bar, results
- [ ] T060 [US1] Migrate `apps/web/src/transcription/TranscriptionSettingsPanel.tsx` onto the shared settings panel (mode, language, turbo)
- [ ] T061 [P] [US1] Migrate `apps/web/src/transcription/TranscriptionRow.tsx` onto Table row + Progress + Badge, covering queued/running/paused/done/failed
- [ ] T062 [P] [US1] Migrate `apps/web/src/transcription/LanguageCombobox.tsx` and `LanguageDoubt.tsx` onto SelectMenu + Alert
- [ ] T063 [P] [US1] Migrate `apps/web/src/transcription/ModelGate.tsx`, `GemmaConsent.tsx`, `TranslatorNotice.tsx` and `TranslationElapsed.tsx` onto Alert + Progress + Button
- [ ] T064 [P] [US1] Migrate `apps/web/src/transcription/ExportMenu.tsx` and `TranscriptionCopyMenu.tsx` onto DropdownMenu
- [ ] T065 [US1] Migrate `apps/web/src/transcription/TranscriptTextModal.tsx` and `TranscriptPlayer.tsx` onto Modal + the product-specific player, splitting the file only as far as the migration needs (it is a known debt, not this feature's target)
- [ ] T066 [US1] Migrate `apps/web/src/styles/transcription.css` onto tokens and delete what the inventory now covers
- [ ] T067 [US1] [US4] Verify C5 at five widths × two themes × reduced motion, including a long transcript and an RTL-ish long language name

---

## Phase 9: [US1] C6 — 2FA notebook and landing viewer

- [ ] T068 [US1] Migrate `apps/web/src/two-factor/TwoFactorPage.tsx` and `TwoFactorRow.tsx` onto Table + Card + Button
- [ ] T069 [P] [US1] Migrate `apps/web/src/two-factor/CodeCell.tsx`, `Countdown.tsx` and `QuickCode.tsx` onto tokens, keeping the expiry ring and copy feedback (no animation on copy — frequent action)
- [ ] T070 [US1] Migrate `apps/web/src/landing-viewer/LandingViewer.tsx`, `LandingViewerWelcome.tsx` and `LandingTree.tsx` onto the inventory (Tree, Empty, Card)
- [ ] T071 [P] [US1] Migrate `apps/web/src/landing-viewer/LandingGalleryGrid.tsx`, `LandingSourceSwitcher.tsx` and `LandingRefreshControl.tsx`
- [ ] T072 [P] [US1] Migrate `apps/web/src/landing-viewer/GallerySettingsMenu.tsx` and `GalleryMoreMenu.tsx` onto DropdownMenu + Choice
- [ ] T073 [US1] Migrate `apps/web/src/styles/landing-viewer.css` onto tokens and delete what the inventory now covers
- [ ] T074 [US1] [US4] Verify C6 at five widths × two themes × reduced motion

---

## Phase 10: [US1] C7 — Account and admin

- [x] T075 [US1] Migrate `apps/web/src/pages/AccountPage.tsx` — profile, language, marketing consent, danger zone (destructive action de-emphasised, confirmation names the consequence)
- [ ] T076 [US1] Migrate `apps/web/src/pages/AdminPage.tsx` — metric tiles onto Card, the user table onto Table (`sm` density), filters onto Select/SegmentedControl, CSV export onto Button
- [ ] T077 [P] [US1] [US2] Give AdminPage its states: loading skeleton, empty result, failed load, and the non-admin permission-limited state
- [ ] T078 [US1] Update `tests/admin-ui.test.tsx` to assert through roles and accessible names
- [ ] T079 [US1] [US4] Verify C7 at five widths × two themes × reduced motion

---

## Phase 11: [US1] C8 — Team: entry and shell

- [x] T080 [US1] Migrate `apps/web/src/team/lobby/SpaceLobby.tsx`, `SpaceCard.tsx` and `InvitationList.tsx` onto Card + Empty + Badge + Button
- [ ] T081 [P] [US1] Migrate `apps/web/src/team/create/CreateSpaceWizard.tsx` and `SpaceNameStep.tsx` onto Modal + Stepper-style header + FormField
- [ ] T082 [US1] Migrate `apps/web/src/team/workspace/WorkspaceShell.tsx` — header, section tabs, and the space header actions — onto Tabs + Button + Breadcrumb
- [ ] T083 [P] [US1] Migrate `apps/web/src/team/workspace/SpaceSwitcher.tsx`, `SpaceStatePanel.tsx`, `RealtimeChip.tsx` and `BackgroundWorkChip.tsx` onto DropdownMenu + Alert + Badge
- [ ] T084 [P] [US1] Migrate `apps/web/src/team/storage/StorageChip.tsx`, `ConnectStorageFlow.tsx` and `SelectionList.tsx` onto Badge + Popover + Modal + Tree
- [x] T085 [US1] [US2] Migrate the unavailable-space screen in `apps/web/src/team/TeamSpace.tsx` onto the Empty pattern (it was re-dressed in 020; make it the pattern rather than a bespoke card)
- [ ] T086 [US1] Update `tests/team-workspace-gate.test.tsx`, `tests/team-connect-flow.test.tsx` and `tests/workspace-section-state.test.tsx` to assert through roles
- [ ] T087 [US1] [US4] Verify C8 at five widths × two themes × reduced motion

---

## Phase 12: [US1] C9 — Team: explorer

- [ ] T088 [US1] Migrate `apps/web/src/team/explorer/ExplorerShell.tsx` — toolbar, view switch, selection bar (with its `Clear selection (N)`), scope controls
- [ ] T089 [P] [US1] Migrate `apps/web/src/team/explorer/ContentList.tsx` and `ContentGrid.tsx` onto Table (`sm`) and a tile grid, keeping today's density
- [ ] T090 [P] [US1] Migrate `apps/web/src/team/explorer/FolderTree.tsx` and `Breadcrumb.tsx` onto Tree and Breadcrumb, keeping drag-and-drop targets
- [ ] T091 [P] [US1] Migrate `apps/web/src/team/explorer/SortMenu.tsx`, `KindFilterMenu.tsx`, `RowActions.tsx` and `ShareButton.tsx` onto DropdownMenu + IconButton (no open/close animation — frequent actions)
- [ ] T092 [P] [US1] [US2] Migrate `apps/web/src/team/explorer/PreviewPane.tsx` with its empty, loading, failed and unsupported states
- [ ] T093 [P] [US1] Migrate `apps/web/src/team/explorer/UploadConflictDialog.tsx`, `FolderScopeDialog.tsx` and `ProcessPanel.tsx` onto Modal + the confirmation pattern
- [ ] T094 [P] [US1] Migrate `apps/web/src/team/catalog/TrashView.tsx` onto Table + Empty + the confirmation pattern (purge is destructive and de-emphasised)
- [ ] T095 [US1] Update `tests/team-explorer-grid.test.tsx` and the explorer's other class-name assertions to roles
- [ ] T096 [US1] [US4] Verify C9 at five widths × two themes × reduced motion, with a 500-row folder

---

## Phase 13: [US1] C10 — Team: catalogue and search

- [ ] T097 [US1] Migrate `apps/web/src/team/catalog/TeamCatalog.tsx` and `CatalogSearchBar.tsx` onto Input (with leading icon) + SegmentedControl for scope
- [ ] T098 [US1] Migrate `apps/web/src/team/catalog/CatalogFilters.tsx` onto Select/SelectMenu + Chip, keeping the facet-driven options and localised values added in 020
- [ ] T099 [P] [US1] [US2] Migrate `apps/web/src/team/catalog/MaterialResults.tsx` with loading skeleton, empty result and failed states
- [ ] T100 [P] [US1] Migrate `apps/web/src/team/catalog/MaterialMetadataEditor.tsx` and `MaterialRowMenu.tsx` onto Modal + FormField + DropdownMenu
- [ ] T101 [P] [US1] Migrate `apps/web/src/team/catalog/ProvenancePanel.tsx`, `FolderPicker.tsx` and `TeamTextEditor.tsx`
- [ ] T102 [US1] [US4] Verify C10 at five widths × two themes × reduced motion

---

## Phase 14: [US1] C11 — Team: tasks

- [x] T103 [US1] Migrate `apps/web/src/team/tasks/TaskSpace.tsx` — board columns, header, filters row
- [ ] T104 [P] [US1] Migrate `apps/web/src/team/tasks/TaskCard.tsx` onto Card + Chip + Progress + Avatar
- [ ] T105 [US1] Migrate `apps/web/src/team/tasks/TaskEditor.tsx` onto Modal + FormField + the shared patterns — the densest dialog in the product
- [ ] T106 [P] [US1] Migrate `apps/web/src/team/tasks/TaskStatusControl.tsx`, `TaskSortControl.tsx`, `TaskDateField.tsx` and `TaskProgressScale.tsx`
- [x] T107 [P] [US1] [US2] Migrate the four filters — `TaskDateFilter.tsx`, `TaskAssigneeFilter.tsx`, `TaskAccountFilter.tsx`, `TaskLabelFilter.tsx` — onto SelectMenu + Popover with their empty states (which link to where the dictionary is filled, as 020 established)
- [x] T108 [P] [US1] Migrate `apps/web/src/team/tasks/TaskAgentTags.tsx`, `TaskAccountPicker.tsx`, `TaskAttachmentPicker.tsx` and `TaskAttachmentTile.tsx` onto the picker pattern (search, breadcrumb, list, footer actions)
- [ ] T109 [US1] Migrate `apps/web/src/styles/team-tasks.css` onto tokens and delete what the inventory covers
- [ ] T110 [US1] Update `tests/team-task-accounts.test.tsx`, `tests/team-task-tags.test.tsx` and `tests/task-progress-scale.test.tsx` to assert through roles
- [ ] T111 [US1] [US4] Verify C11 at five widths × two themes × reduced motion

---

## Phase 15: [US1] C12 — Team: accounts

- [x] T112 [US1] Migrate `apps/web/src/team/accounts/AccountSpace.tsx` — header, summary, search, filter pills, the fold-all control and the money column's fold control
- [ ] T113 [US1] Migrate `apps/web/src/team/accounts/AccountGroup.tsx` and `AgentRow.tsx` onto Table (`xs` density — this is the product's density reference)
- [ ] T114 [P] [US1] Migrate `apps/web/src/team/accounts/AgentMoney.tsx` onto InputNumber with steppers
- [ ] T115 [P] [US1] Migrate `apps/web/src/team/accounts/AgentLabels.tsx`, `MarkerFilter.tsx` and `Marked.tsx` onto Chip + DropdownMenu + the highlight token
- [ ] T116 [US1] Migrate `apps/web/src/styles/team-accounts.css` onto tokens and delete what the inventory covers
- [ ] T117 [US1] Update `tests/team-accounts.test.tsx` class-name assertions to roles, keeping every behavioural assertion intact
- [ ] T118 [US1] [US4] Verify C12 at five widths × two themes × reduced motion, with the money column folded and unfolded

---

## Phase 16: [US1] C13 — Team: settings and members

- [ ] T119 [US1] Migrate `apps/web/src/team/workspace/SettingsDialog.tsx` and `SpaceSettings.tsx` — the sticky bar and the five tabs — onto Modal + Tabs
- [ ] T120 [US1] Migrate `apps/web/src/team/workspace/SettingsSection.tsx` onto Card (section role), and with it `TeamPreferencesSection.tsx` and the share-preference panel
- [x] T121 [P] [US1] Migrate `apps/web/src/team/drive/DriveConnectionPanel.tsx` and `BetaStorageNotice.tsx` onto Card + Badge + Alert, covering connected / needs-reauth / root-missing / unavailable
- [x] T122 [P] [US1] Migrate `apps/web/src/team/members/MemberList.tsx`, `InvitationPanel.tsx`, `MemberPermissionsDialog.tsx` and `OwnershipTransferDialog.tsx` onto Table + Modal + Choice
- [ ] T123 [P] [US1] Migrate `apps/web/src/team/members/TeamAuditPanel.tsx` onto Timeline
- [x] T124 [P] [US1] Migrate `apps/web/src/team/labels/TaskLabelsSection.tsx`, `TaskLabelChip.tsx` and `TaskLabelMenu.tsx` onto Chip + Popover + the empty-state pattern
- [ ] T125 [US1] Migrate `apps/web/src/team/workspace/RestitchDefaultsSection.tsx` onto the shared settings panel and picto RadioGroup
- [ ] T126 [US1] Migrate the leave-space panel and its confirmation onto the confirmation pattern
- [ ] T127 [US1] Update `tests/team-members.test.tsx`, `tests/team-direct-member.test.tsx`, `tests/team-invitation-link.test.tsx` and `tests/team-restitch-section.test.tsx` to assert through roles
- [ ] T128 [US1] [US4] Verify C13 at five widths × two themes × reduced motion, on all five tabs

---

## Phase 17: [US1] C14 — Team: media and processing

- [ ] T129 [US1] [US2] Migrate `apps/web/src/team/preview/MaterialPreview.tsx` and `PreviewUnavailable.tsx` — media, transcript, archive and landing previews with their loading, failed and unsupported states
- [ ] T130 [P] [US1] Migrate `apps/web/src/team/preview/LandingPreviewFrame.tsx`, `apps/web/src/team/landings/LandingFullView.tsx` and `LandingViewerControls.tsx`
- [ ] T131 [US1] Migrate `apps/web/src/team/processing/MaterialProcessFlow.tsx`, `ProcessMaterialDialog.tsx` and `OperationStatus.tsx` onto Modal + Progress + Alert, keeping the stage copy
- [ ] T132 [P] [US1] Migrate `apps/web/src/team/library/BulkUploadDialog.tsx` and `ProcessLibraryDialog.tsx` onto Modal + FileUpload + Progress, including the per-file partial-failure state
- [ ] T133 [P] [US1] Migrate `apps/web/src/team/library/LibraryShareActions.tsx`, `VideoTextActions.tsx` and `CopyDriveLinkButton.tsx` onto Button + DropdownMenu (copy gives feedback without animation)
- [ ] T134 [US1] [US4] Verify C14 at five widths × two themes × reduced motion

---

## Phase 18: [US2] The state sweep

**Goal**: prove every screen's state set is complete, not merely that each screen looks
better.

- [ ] T135 [US2] Walk `contracts/screens.md` row by row in the beta, forcing every listed state; record any state that has no design in `specs/021-design-system-redesign/findings.md`
- [ ] T136 [US2] Fix every gap found in T135 by applying the shared pattern — no new one-screen treatments
- [ ] T137 [P] [US2] Verify every empty state that can be resolved by an action offers that action as a control (FR-021), across all fourteen groups
- [ ] T138 [P] [US2] Verify every destructive action is de-emphasised relative to the safe action beside it and its confirmation names the consequence in a verb (FR-020)
- [ ] T139 [P] [US2] Verify every permission-limited surface hides or explains rather than disabling (FR-004 acceptance), for viewer, editor, admin and owner

---

## Phase 19: [US3] The motion sweep

- [x] T140 [US3] Audit every `transition` and `animation` declaration in `apps/web/src/styles*.css`: none over 300ms, none on a layout-affecting property, all easing from the two curves
- [ ] T141 [US3] Verify the frequent-action exclusions: menus, row hover, selection toggles, theme toggle, keyboard shortcuts and tag popovers animate not at all
- [ ] T142 [P] [US3] Verify every overlay opens from its trigger's origin at 0.95 scale (FR-026)
- [ ] T143 [P] [US3] Walk the whole product with `prefers-reduced-motion: reduce` and confirm no state is communicated by motion alone
- [x] T144 [P] [US3] Verify interrupted transitions resume from their current position rather than restarting (FR-030), on the three surfaces where it is visible: dialogs, the folder tree, the task board

---

## Phase 20: [US4] The width, theme and access sweep

- [ ] T145 [US4] Walk every row of `contracts/screens.md` at 1920/1440/1024/768/390 in both themes; record every overlap, clip or horizontal scroll in `findings.md` and fix it
- [ ] T146 [P] [US4] Run the contrast audit across every surface in both themes; fix every AA failure at the token level rather than per screen
- [ ] T147 [P] [US4] Walk the product by keyboard alone: focus order follows reading order, focus is always visible, dialogs trap and restore focus
- [ ] T148 [P] [US4] Verify every control with the longer (Ukrainian) translation; fix anything that clips or overflows
- [ ] T149 [P] [US4] Verify no state is communicated by colour alone (FR-032), particularly the marker colours, connection states and task statuses
- [ ] T157 [P] [US1] Audit every paragraph and helper text in the product for the 70ch measure cap (FR-023); fix at the pattern level, not per screen
- [ ] T158 [P] [US1] Audit every surface for exactly one `primary`-variant control, positioned at the end of the reading flow (FR-022); demote the extras to `secondary` or `ghost`

---

## Phase 21: Polish and close-out

- [ ] T150 Delete every dialect class left orphaned by C1–C14 from `apps/web/src/styles.css` and the four style modules; confirm the total line count has fallen
- [ ] T151 Empty the token-lint allow-list from T011 and confirm `node scripts/check-design-tokens.mjs` passes with zero exemptions
- [ ] T152 [P] Add the token reference and the component inventory to `docs/DESIGN.md` (the product's rule book), leave `docs/DESIGN-PRINCIPLES.md` as the craft reference it is, and point `README.md` and `AGENTS.md` at both as the contributor path
- [ ] T153 [P] Record the behaviour findings gathered during the migration in `specs/021-design-system-redesign/findings.md` as candidates for a follow-up feature — none of them fixed inside this one (FR-037)
- [ ] T154 Run the full gate: `npm run typecheck`, `npx vitest run`, `npm run lint`, `node scripts/check-design-tokens.mjs`
- [ ] T155 Verify the demo route is absent from a production build and the bundle has not grown
- [ ] T159 Add every string this feature introduced or rewrote (empty states, error copy, confirmation verbs, permission explanations) to both languages in `apps/web/src/i18n.ts`, and confirm `tests/i18n.test.ts` and `tests/team-i18n-glossary.test.ts` pass (FR-034)
- [ ] T160 Prove SC-009: build one throwaway screen from the inventory alone and confirm it needs no new token and no new component variant; record the result in `specs/021-design-system-redesign/findings.md` and delete the screen

---

## Dependencies

```text
Phase 1 (Setup)
  └─> Phase 2 (Tokens) ─── blocks everything
        └─> Phase 3 (Inventory) ─── blocks every screen group
              ├─> Phase 4  C1   ┐
              ├─> Phase 5  C2   │
              ├─> Phase 6  C3   │
              ├─> Phase 7  C4   │
              ├─> Phase 8  C5   │  any order,
              ├─> Phase 9  C6   │  any number
              ├─> Phase 10 C7   │  in parallel,
              ├─> Phase 11 C8   │  each shippable
              ├─> Phase 12 C9   │  on its own
              ├─> Phase 13 C10  │
              ├─> Phase 14 C11  │
              ├─> Phase 15 C12  │
              ├─> Phase 16 C13  │
              └─> Phase 17 C14  ┘
                    └─> Phases 18–20 (sweeps: states, motion, widths)
                          └─> Phase 21 (close-out)
```

**Within a screen group**: the migration tasks come first, then the test updates, then the
verification task. The verification task closes the group.

**Across screen groups**: none. C2 (shell) touching a surface another group also touches is
the only contact point, and it lands first by convention, not by dependency.

## Parallel execution examples

**Phase 2** — after T004/T005: `T006`, `T010`, `T012` are three different files.

**Phase 3** — after T014 (Button, which everything composes): `T015`, `T016`, `T017`, `T020`,
`T024`, `T025` in parallel; `T018`/`T019` share `Field.tsx`/`Choice.tsx` and do not.

**Screen groups** — any of C1–C14 may run concurrently once Phase 3 is done. A realistic
split for two people: one takes C1–C7 (the tools side), the other C8–C14 (the team side);
they meet at Phase 18.

**Within C9** — `T089`, `T090`, `T091`, `T092`, `T093`, `T094` touch six different files.

## Implementation strategy

**MVP**: Phases 1–3 plus C1 and C2. That is the system, the inventory and the frame every
screen sits in — at which point the product already reads as one product at its edges, and
every remaining group is a contained cleanup.

**Incremental delivery**: each screen group is a commit (or a small series) that leaves the
product shippable. A group is done when its verification task passes; nothing is left
half-migrated overnight.

**Order after the MVP**: C3 (compressor — the most-used tool, and the visual reference the
owner names), then C11/C12 (tasks and accounts — the densest surfaces, where the system is
most tested), then the rest in any order.

**Stop rule**: if a group reveals behaviour that is wrong rather than ugly, it is recorded in
`findings.md` and left alone. This feature changes how the product looks, not what it does.

---

## Analysis pass (2026-09-13)

Run after generation, against `spec.md`, `plan.md`, `contracts/` and the constitution.
Findings and what was done about them:

| ID | Category | Severity | Finding | Resolution |
|---|---|---|---|---|
| C1 | Coverage gap | HIGH | SC-003 ("a control of a given role is visually identical everywhere", verified by comparing rendered measurements) had no task that measures anything. | Added **T156** — a consistency test that renders each role and asserts computed height, radius, font-size and icon size. |
| C2 | Coverage gap | HIGH | SC-009 ("a new screen built from the inventory needs no new token") had no verifying task. | Added **T160** — build a throwaway screen from the inventory, record the result, delete it. |
| C3 | Coverage gap | MEDIUM | FR-022 (exactly one `primary` control per surface) was implied by the migrations but never checked. | Added **T158** — a product-wide audit that demotes the extras. |
| C4 | Coverage gap | MEDIUM | FR-023 (70ch measure) was only covered on the legal pages and the public home (T035, T036). | Added **T157** — a product-wide audit, fixed at the pattern level. |
| C5 | Coverage gap | MEDIUM | FR-034 (both languages for every string this work introduces) had no task; new empty-state and confirmation copy would have landed in one language. | Added **T159** to the close-out phase. |
| A1 | Underspecification | MEDIUM | T031 tested only that disabled and loading are distinct, while FR-010 requires every declared state to be distinct from every other. | T031 rewritten to assert the full state set, citing FR-010/FR-011/FR-012. |
| I1 | Inconsistency | MEDIUM | `plan.md` labelled its phases A–D; `tasks.md` numbers them 1–21. Nothing mapped one to the other. | `plan.md` phase headings now carry their `tasks.md` phase and task ranges. |
| U1 | Underspecification | LOW | T003 said to copy `docs/DESIGN-PRINCIPLES.md` into the repo; it is already there. | T003 rewritten to what is actually left: putting it on the contributor path in `README.md` and `AGENTS.md`. |
| U2 | Inconsistency | LOW | T011 referenced a task number (T170) that does not exist. | Corrected to T151, the task that empties the allow-list. |
| D1 | Labelling | LOW | Phase 3 (the inventory) is labelled `[US5]` though it mostly serves US1. | Left as is: US5 is the story the inventory *proves* (a new screen is cheap to build), and every screen group carries `[US1]`. Recorded here so the label is not read as a mistake. |
| S1 | Source conflict | HIGH | The feature was written against a `DESIGN.md` supplied from outside the repo, while `docs/DESIGN.md` already existed — the product's own rule book (lucide 20/1.75, picto groups, inline fields, validation timing, icon plates). Writing the new file to that path would have destroyed it, and the spec would have been governed by a document that ignores the product's existing decisions. | The external document is now `docs/DESIGN-PRINCIPLES.md`; `docs/DESIGN.md` is restored untouched. **FR-040** makes the product's own rules binding on the inventory, **R13** records which document wins where, and **T161** encodes those rules into the components. |

**Coverage after the pass**: 40 functional requirements, 10 success criteria, 161 tasks.
Every FR and every SC maps to at least one task. No constitution principle is in conflict —
the feature serves principle VI directly and leaves I–V untouched.

**Not fixed, deliberately**: the spec's Assumptions name React, CSS custom properties and the
constitution's frontend seams. A strict reading of "no implementation details in a spec"
would remove them; they stay because they are the constraints the whole design rests on, and
hiding them would make the plan's central decision (reference, not dependency) unexplainable.

---

## Implementation log (2026-09-13, light mode)

Written while a release held the machine, so nothing was typechecked, tested or
opened in the beta — that is the first thing to do when the release lets go.

**Done** (49 of 161 by task, more by effect): the whole foundation and inventory,
plus the screen work that could be done without a browser to check it in.

- **Phase 1–2, T001–T012** — `styles/tokens.css` (seven roles × two themes, the
  type ramp, space/radius/shadow/motion/layer, control geometry),
  `styles/base.css`, the legacy alias block, `scripts/check-design-tokens.mjs`
  wired into `verify` with 25 exemptions, and `tests/design-tokens.test.ts`.
- **Phase 3, T014–T032 + T156 + T161** — `components/ui/` with 45 components in
  nine family files, the five state patterns, `styles/components.css`, the
  `/design` demo behind `import.meta.env.DEV`, and two test files.
- **Screens** — C1 in full (sign-in, the four whole-screen states, legal pages),
  parts of C2, C7, C8, C11, C12: every `.inline-alert` call site in the product,
  five empty states, three pickers' loading/empty/failed states.
- **The class floor** — the pre-021 names re-expressed in tokens, loaded before
  `styles.css`, so each group's migration becomes a deletion rather than a
  rewrite.

**One decision changed along the way.** The roles were first written with violet
as `primary`; it is honey. `.button-primary` has been honey since the beginning
and every call to action in the product is honey, while violet is identity,
navigation, selection and focus. Swapped before anything depended on it, and the
aliases were adjusted so no screen changed colour. Recorded in commit
`72e6d52`.

**The class floor changes what is left to do.** Nine of the fourteen screen
groups are largely a deletion now rather than a rewrite: the pre-021 names —
buttons, inline notices, empty states, dialog footers, picker rows, tab strips,
icon plates, toasts, status badges — are all re-expressed in tokens and loaded
*before* `styles.css`. A group's remaining work is to delete its own copies from
`styles.css` and let the screen land on the floor, then swap the handful of
components that need real markup changes. That is still work, and it still needs
eyes on a running beta, but it is no longer "rewrite fourteen screens".

**What genuinely remains, and why it needs a browser:**

- the geometry-heavy screens — compressor settings, the transcript modal, the
  landing viewer, the explorer grid — where markup and layout move together;
- the four whole-product sweeps (states, motion, widths, contrast), none of
  which can be done without looking;
- deleting the pre-021 rules from `styles.css`, which is safe only once each
  group has been seen on the floor;
- the test updates for class-name assertions the migrations break.

**First things to run when the machine is free** (in this order):

1. `npm run typecheck` — the inventory is 3,000 lines of unchecked TypeScript.
2. `npx vitest run tests/design-tokens.test.ts tests/ui-components.test.tsx tests/ui-consistency.test.tsx`
3. `npx vitest run` — the existing suite, for what the shared `Button` and the
   class floor moved.
4. `node scripts/check-design-tokens.mjs`
5. The beta at `/design`, then the five screens in T013.
