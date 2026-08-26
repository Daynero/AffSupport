# Tasks: Переосмислений UX командного режиму

**Input**: Design documents from `/specs/010-team-ux-refresh/`

**Prerequisites**: plan.md, spec.md (7 stories), research.md (D1–D15), data-model.md, contracts/, findings.md (evidence IDs)

**Tests**: Included — the plan's design explicitly defines one jsdom suite per story plus a PGlite suite and a glossary-enforcement test (constitution: `npm test` is a mandatory gate). Suites may be written alongside their story's implementation; the glossary and RPC suites are contract tests and should be written against the contract first.

**Organization**: Tasks are grouped by user story (US1–US7 from spec.md) so each story is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US7 for story phases; setup/foundational/polish tasks carry no story label
- All paths are repo-relative

---

## Phase 1: Setup

**Purpose**: Confirm the evidence base and prepare shared visual groundwork. No dependencies to install — the plan adds zero runtime dependencies.

- [X] T001 Confirm the behavioral audit claims in a running beta app before building against them (findings confidence note): dialog stacking/under-modal rendering (C1), sync-banner freeze on dropped realtime (S5), contradictory sync label (S4), batch cancel-on-close (B1); append confirmations (or corrections) to specs/010-team-ux-refresh/findings.md
- [X] T002 [P] Add shared layer tokens (`--layer-modal`, `--layer-toast`, retirement plan for the 45/80 z-index bands) and base skeleton/chip utility classes in apps/web/src/styles.css

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The notification channel, error humanization, route model, and the one backend migration every later story leans on.

**⚠️ CRITICAL**: complete before any user story phase.

- [X] T003 Create `ToastProvider`/`useToasts`/`ToastContextOverride` (context idiom, `aria-live="polite"`, tones success/error/info, optional one-shot action, `sticky` support, auto-dismiss) in apps/web/src/components/toast.tsx and mount it in the team shell tree (apps/web/src/team/TeamSpace.tsx)
- [X] T004 [P] Toast visual styles (stack, tones, action button, reduced-motion) in apps/web/src/styles.css
- [X] T005 [P] Create `teamErrorMessage(code, t)` mapping every known `TeamErrorCode` to a `TranslationKey` with a generic-unknown fallback in apps/web/src/team/errors.ts, plus the error-copy keys for both locales in apps/web/src/i18n.ts (contracts/ui-conventions.md)
- [X] T006 [P] Create the route model `parseTeamRoute`/`buildTeamRoute` (sections files|tasks|creatives|landings|settings|trash; query q/task/folder; total parsing per contracts/routes-and-navigation.md) in apps/web/src/team/routes.ts with unit tests in tests/team-routes.test.ts
- [X] T007 Switch `/team` exact match to prefix matching and pass the parsed route into `TeamSpace` (behavior-compatible until US1 consumes it) in apps/web/src/ProtectedSoty.tsx
- [X] T008 Write the forward-only migration adding `leave_team`, `delete_draft_team` (guard: refuses teams that ever had a drive connection → `TEAM_NOT_DRAFT`), `delete_team_task`, `list_team_trashed_materials` — all `security definer` + `set search_path = ''`, narrow grants, audit rows `membership.left`/`team.draft_deleted`/`task.deleted` — in supabase/migrations/, with reverse steps documented in ROLLBACK.md (contracts/rpc-and-backend.md)
- [X] T009 Regenerate DB types (`npm run types:supabase`) and the PGlite contract SQL (`node scripts/generate-team-contract-sql.mjs`) so the harness sees the new functions; commit both outputs
- [X] T010 Add typed client wrappers `leaveTeam`, `deleteDraftTeam`, `deleteTask`, `listTrashedMaterials` (rpc → throwRpc → unknown-narrowing guard, no `as`) in apps/web/src/api/team.ts
- [X] T011 [P] PGlite contract tests for the four functions (owner cannot leave; member leave revokes reads; draft-delete refuses ever-connected teams and cascades; task delete honors edit permission and detaches links; trash listing honors view + keyset paging; audit rows written) in tests/team-lifecycle-rpc.test.ts

**Checkpoint**: toasts, error mapper, routes, and backend lifecycle functions exist — story phases can start (and can proceed in parallel).

---

## Phase 3: User Story 1 - Орієнтація: користувач завжди знає, де він (Priority: P1) 🎯 MVP

**Goal**: Real tabs with an explicit Files tab, space-name switcher, URL-addressable sections (refresh/Back/deep links), single-ready-space direct entry, wizard Back. (FR-001..006; findings N1–N5)

**Independent Test**: spec US1 — walk tabs, refresh, use Back, switch space via its name, share a section link (member vs non-member), enter with one ready space, wizard round-trip.

- [X] T012 [US1] Make `TeamSpace` URL-driven: resolver order `?drive=` resume → URL space → pending invitations ⇒ lobby → exactly one `ready` space ⇒ `replace`-redirect into it → remembered space ⇒ redirect → lobby; `enterSpace` navigates to `/team/<id>`; URL always beats the localStorage cache; neutral no-access screen (identical for absent/denied) in apps/web/src/team/TeamSpace.tsx (research D14, contracts/routes-and-navigation.md)
- [X] T013 [US1] Replace the six toggle buttons with a `<nav>` of section links (Файли · Завдання · Креативи · Лендінги) using `internalLink()` + `aria-current="page"`, render the active section from the route, and separate utilities (settings link, switcher) from content tabs in apps/web/src/team/workspace/WorkspaceShell.tsx
- [X] T014 [P] [US1] Space switcher on the space name (current space + list of other spaces + "усі простори" → lobby) in apps/web/src/team/workspace/SpaceSwitcher.tsx, wired into the shell header
- [X] T015 [US1] Restore view state from query params: `?folder=` re-opens the Files browser position, `?task=` opens the task editor over Tasks, `?q=`+filters restore search state; navigating sections updates the URL in apps/web/src/team/workspace/WorkspaceShell.tsx, apps/web/src/team/catalog/MaterialBrowser.tsx, apps/web/src/team/tasks/TaskSpace.tsx
- [X] T016 [P] [US1] Wizard: add Back from the folder step to the name step preserving entered state (reuse the existing `teamCreateBack` key) in apps/web/src/team/create/ConnectFolderStep.tsx and apps/web/src/team/create/CreateSpaceWizard.tsx
- [X] T017 [P] [US1] Tab-bar and header styles: tab affordance with clear active state, utilities cluster, fix the 560–860 px ragged wrap (findings P3) in apps/web/src/styles.css
- [X] T018 [US1] Lobby: entering a card navigates to `/team/<id>`; the remembered-space redirect lives in the resolver only (no double-entry paths) in apps/web/src/team/lobby/SpaceLobby.tsx and apps/web/src/team/lobby/SpaceCard.tsx
- [X] T019 [P] [US1] jsdom suite: tabs render + active marking, direct-action return to Files, refresh restores space+section, Back walks sections before leaving, single-ready-space direct entry (suppressed by pending invitations), neutral no-access screen, wizard Back keeps the name — in tests/team-ux-navigation.test.tsx

**Checkpoint**: US1 fully functional — navigation skeleton delivered (MVP).

---

## Phase 4: User Story 2 - Файлові дії там, де файли (Priority: P2)

**Goal**: Full permission-shaped file actions on Files rows, search/filters available whenever the space has content anywhere, visual folder picker everywhere, pager past 50, live tree. (FR-007..012; findings F1–F6, P1)

**Independent Test**: spec US2 — in a space with a folder-only root: find search, rename/move a file from its row via the picker in ≤3 actions, page past 50 results, watch a teammate's change appear, press `/`.

- [X] T020 [US2] Split `MaterialActions` into a headless `useMaterialActions` hook (operation calls, busy/error, idempotency keys) in apps/web/src/team/catalog/useMaterialActions.ts and a lazily-mounted `MaterialRowMenu` (renders content only when opened — kills the 50-live-instances problem) in apps/web/src/team/catalog/MaterialRowMenu.tsx
- [X] T021 [US2] Adopt `MaterialRowMenu` in the Files browser rows with `destinationFolderId` = current folder (revives the dead "Upload new version" and conflict-replace branches — wire, don't delete), pass the realtime `revision` so the tree refreshes live, in apps/web/src/team/catalog/MaterialBrowser.tsx and apps/web/src/team/workspace/WorkspaceShell.tsx; reuse the same menu in apps/web/src/team/catalog/MaterialResults.tsx
- [X] T022 [P] [US2] Build `FolderPicker` — a Modal navigating catalog folders via `listMaterials(teamId, parent)` filtered to `kind === 'folder'`, breadcrumb + "Select current folder" — in apps/web/src/team/catalog/FolderPicker.tsx
- [X] T023 [US2] Replace all three raw-ID destination inputs with `FolderPicker`: move (apps/web/src/team/catalog/MaterialRowMenu.tsx), process output (apps/web/src/team/processing/ProcessMaterialDialog.tsx — no more pre-shown error), save-text-as-new-version (apps/web/src/team/catalog/TeamCatalog.tsx)
- [X] T024 [US2] Derive content availability from the space-wide freshness probe (`discoveredCount > 0 || total > 0`), never from the open folder; search/filters follow FR-008 (truly empty space stays clean), file actions are never gated by it — in apps/web/src/team/workspace/WorkspaceShell.tsx and apps/web/src/team/useCatalogFreshness.ts
- [X] T025 [US2] Search lives under Files: `?q=`/filter sync with the URL and a load-more/pager control over the existing `page` state so results past 50 are reachable, in apps/web/src/team/catalog/TeamCatalog.tsx and apps/web/src/team/catalog/useCatalogSearch.ts
- [X] T026 [P] [US2] `/` focuses the search field in sections that have one (small hook, no global shortcut system) in apps/web/src/team/catalog/CatalogSearchBar.tsx
- [X] T027 [P] [US2] jsdom suite: row menu offers the full permission-shaped set, folder-only root keeps search available, picker replaces ID inputs, pager reaches page 2, revision prop refreshes the tree, `/` focuses search — in tests/team-ux-files.test.tsx

**Checkpoint**: file management is where the files are; search cannot disappear.

---

## Phase 5: User Story 3 - Кожна дія має видимий результат (Priority: P3)

**Goal**: One notification mechanism for every outcome, no silent controls, labeled loading, truthful sync incl. failure/retry, visible realtime degradation, explained membership loss. (FR-013..019; findings S1–S8)

**Independent Test**: spec US3 — fault-injected walkthrough: every action toasts success or human error; provenance failure speaks; scanning/failed states render; offline shows the chip and the banner keeps moving; a removed member gets an explanation.

- [X] T028 [US3] Route all catalog/file operation outcomes through toasts + `teamErrorMessage` (delete the raw `Error.message` passthrough), including success confirmations for rename/move/upload/process-start, in apps/web/src/team/catalog/useMaterialActions.ts, apps/web/src/team/catalog/MaterialRowMenu.tsx, apps/web/src/team/processing/ProcessMaterialDialog.tsx, apps/web/src/team/catalog/TeamTextEditor.tsx
- [X] T029 [P] [US3] Close the fire-and-forget gaps with `.catch` + mapped toasts: remove member (apps/web/src/team/members/MemberList.tsx), resend/revoke invitation (apps/web/src/team/members/InvitationPanel.tsx), detach drive (apps/web/src/team/drive/DriveConnectionPanel.tsx), visible copy-link failure (apps/web/src/team/catalog/CopyDriveLinkButton.tsx), correct clipboard-error attribution (apps/web/src/team/library/LibraryShareActions.tsx), partial bulk-move names the failed items (apps/web/src/team/library/CreativeLibrary.tsx)
- [X] T030 [US3] Kill the silent no-ops: provenance fetch gets `.catch` + error toast and an honest "no provenance recorded" panel body (apps/web/src/team/catalog/TeamCatalog.tsx, apps/web/src/team/preview/ProvenancePanel.tsx); "Edit text" renders disabled-with-reason instead of silently returning while a transcript is not `full` (apps/web/src/team/catalog/MaterialRowMenu.tsx, apps/web/src/team/catalog/TeamCatalog.tsx)
- [X] T031 [US3] Operation truth: a failed local process start surfaces `failed` + code (no silent cancel masquerading as "canceled") in apps/web/src/team/catalog/TeamCatalog.tsx and apps/web/src/team/processing/OperationStatus.tsx
- [X] T032 [P] [US3] Labeled loading everywhere the audit found bare "…": lobby (apps/web/src/team/lobby/SpaceLobby.tsx), Files tree (apps/web/src/team/catalog/MaterialBrowser.tsx), search results first-load (apps/web/src/team/catalog/MaterialResults.tsx), operation pending (apps/web/src/team/catalog/TeamCatalog.tsx), labeled access-check screen (apps/web/src/team/TeamSpace.tsx), with skeleton classes from apps/web/src/styles.css
- [X] T033 [US3] Truthful sync banner: render `failed` (with "Спробувати ще раз" → `resyncDrive`) and `unavailable`; delete the contradictory hardcoded `syncLabel` prop path — in apps/web/src/team/SyncProgress.tsx, apps/web/src/team/workspace/WorkspaceShell.tsx, apps/web/src/team/catalog/MaterialBrowser.tsx
- [X] T034 [US3] Freshness poll fallback while realtime is degraded during an active scan; degraded-only realtime chip in the shell header; membership-lost sticky toast before landing in the lobby — in apps/web/src/team/useCatalogFreshness.ts, apps/web/src/team/TeamContext.tsx, apps/web/src/team/workspace/WorkspaceShell.tsx
- [X] T035 [P] [US3] jsdom suite: outcome toast per action (success + mapped error), no raw codes in DOM, provenance failure feedback, sync failed→retry, chip on degraded realtime, membership-lost explanation — in tests/team-ux-feedback.test.tsx

**Checkpoint**: nothing silent, nothing frozen, nothing contradictory.

---

## Phase 6: User Story 4 - Запрошення і вихід без глухих кутів (Priority: P4)

**Goal**: Invitations visible in the lobby (+ entry badge), leave space, delete draft space, explanatory disconnected-space state. (FR-021..024; findings I1–I4)

**Independent Test**: spec US4 — invite flow end-to-end from the lobby, leave a space, abandon a wizard then delete the draft, viewer sees the detached-space explanation.

- [X] T036 [US4] Extract the account-page invitation inbox into a shared `InvitationList` (who/where/role + accept/decline inline; accept → enter space or show "готується" card) in apps/web/src/team/lobby/InvitationList.tsx; render it at the top of the lobby in apps/web/src/team/lobby/SpaceLobby.tsx and reuse it in apps/web/src/pages/AccountPage.tsx
- [X] T037 [P] [US4] Pending-invitations badge on the Home team card (non-blocking `listMyInvitations` count; failure renders no badge) in apps/web/src/HomePage.tsx
- [X] T038 [US4] "Вийти з простору": non-owner action in apps/web/src/team/workspace/SpaceSettings.tsx with a named-consequence confirm → `teamApi.leaveTeam` → toast (incl. the standing Drive-ACL warning) → navigate to the lobby; owners see the transfer-ownership explanation instead
- [X] T039 [US4] "Видалити чернетку": owner-only action on `setup_incomplete` lobby cards with confirm → `teamApi.deleteDraftTeam` (server enforces true draftness via `TEAM_NOT_DRAFT`) → refetch, in apps/web/src/team/lobby/SpaceCard.tsx and apps/web/src/team/lobby/SpaceLobby.tsx
- [X] T040 [US4] Explanatory space-state panel for members of a detached/needs-reauth space (what happened, whom to ask; role-aware — managers see the path to the Drive panel) replacing the empty file tree, in apps/web/src/team/catalog/MaterialBrowser.tsx and apps/web/src/team/workspace/WorkspaceShell.tsx
- [X] T041 [P] [US4] jsdom suite: invitation visible in lobby + accept enters space + decline clears, badge presence, leave flow (confirm → gone → no-access), draft delete (owner-only affordance), detached-state explanation for a viewer — in tests/team-ux-lifecycle.test.tsx

**Checkpoint**: the membership lifecycle has no dead ends.

---

## Phase 7: User Story 5 - Зворотність замість зайвих підтверджень (Priority: P5)

**Goal**: Undo-first trash with a trash view, draft-first task creation, task delete, proportional confirmations. (FR-025..028; findings R1–R3)

**Independent Test**: spec US5 — trash+Undo, restore from the trash view, draft cancel leaves nothing, delete a task, consequence-naming confirms on drive/invitation actions, no-dialog attachment detach with Undo.

- [X] T042 [US5] Trash without a confirm: immediate `trashMaterial` + success toast carrying Undo → `restoreMaterial` (same idempotency-key discipline); undo races (already restored/purged) surface the operation's mapped code — in apps/web/src/team/catalog/useMaterialActions.ts and apps/web/src/team/catalog/MaterialRowMenu.tsx
- [X] T043 [US5] Trash view at `/team/<id>/trash`: newest-first list over `listTrashedMaterials` with Restore per row, honest Drive-retention note, entry link in the Files toolbar — new apps/web/src/team/catalog/TrashView.tsx wired in apps/web/src/team/workspace/WorkspaceShell.tsx (+ list styles in apps/web/src/styles.css)
- [X] T044 [US5] Draft-first task creation: "Create task" (card, selection, header) opens `TaskEditor` in draft mode (local object, staged attachment ids, title prefilled); server write only on Save (`createTask` + `attachTaskMaterials`); Cancel/Escape prompts only when edited — in apps/web/src/team/tasks/TaskSpace.tsx and apps/web/src/team/tasks/TaskEditor.tsx
- [X] T045 [US5] Task delete: action for edit-permission holders with a confirm naming the consequence → `teamApi.deleteTask` → board refresh + toast, in apps/web/src/team/tasks/TaskEditor.tsx and apps/web/src/team/tasks/TaskCard.tsx
- [X] T046 [P] [US5] Attachment detach: drop the nested confirm modal — immediate detach + Undo toast that re-attaches via `attachTaskMaterials`, in apps/web/src/team/tasks/TaskAttachmentTile.tsx
- [X] T047 [US5] Consequence-naming confirms where they belong: detach drive and revoke invitation get confirm dialogs that state the consequence; replace-root goes through the same server-validated confirmation path as the initial connect (no client-fabricated confirm) — in apps/web/src/team/drive/DriveConnectionPanel.tsx and apps/web/src/team/members/InvitationPanel.tsx
- [X] T048 [P] [US5] jsdom suite: trash→Undo→restored, trash view restore, draft cancel leaves zero records, task delete flow, attachment detach without dialog + Undo, confirm copy names consequences — in tests/team-ux-reversibility.test.tsx

**Checkpoint**: friction is proportional to risk; mistakes are cheap.

---

## Phase 8: User Story 6 - Один інтерфейс: мова, діалоги, стани (Priority: P6)

**Goal**: One dialog primitive everywhere, enforced glossary in both locales, honest empty states, Close vs Cancel. (FR-029..031, FR-020; findings C1–C3, S9)

**Independent Test**: spec US6 — Escape/backdrop/no-stacking across every dialog; glossary test green; empty states distinguish loading/empty/filtered.

- [X] T049 [US6] Port `ProcessMaterialDialog` and `TeamTextEditor` onto `components/Modal` (Escape, focus trap, scroll lock, backdrop; unsaved-changes prompt for the editor) in apps/web/src/team/processing/ProcessMaterialDialog.tsx and apps/web/src/team/catalog/TeamTextEditor.tsx
- [X] T050 [US6] Collapse `TeamCatalog`'s seven overlay booleans into one discriminated `overlay` union and port the operation/provenance/text-version overlays onto `Modal` in apps/web/src/team/catalog/TeamCatalog.tsx
- [X] T051 [US6] Port `MaterialPreview` and `LandingFullView` onto a full-bleed `Modal` variant; retire the 45/80 z-index bands to the shared layer tokens; wrap the landing toolbar on narrow widths; drop the fixed 278 px task-grid rows — in apps/web/src/team/preview/MaterialPreview.tsx, apps/web/src/team/landings/LandingFullView.tsx, apps/web/src/styles.css
- [X] T052 [US6] Glossary key mechanics: collapse `teamFileCancel`/`teamCreateCancel` into `teamCancel`, add `teamClose` and relabel close-only surfaces, split the reused loading key into list/item variants, rename section-label keys to the canonical set — ride the `TranslationKey` union through every call site, in apps/web/src/i18n.ts and affected team components
- [X] T053 [US6] Copy pass per contracts/glossary.md in both locales: Простір/Space as the object noun, файли/files for content, «Завдання» (no «Таски»), «Креативи» as the section label (stages keep their physical Finds/Library names), real gate title replacing «ДОНТ ПУШ ЗЕ ХОРСИС» in en and uk — in apps/web/src/i18n.ts
- [X] T054 [US6] Truthful empty states: task list distinguishes loading/empty/filtered and offers "create your first task"; search results first-load never says "no matches"; audit panel gets a loading state — in apps/web/src/team/tasks/TaskSpace.tsx, apps/web/src/team/catalog/MaterialResults.tsx, apps/web/src/team/members/TeamAuditPanel.tsx
- [X] T055 [P] [US6] jsdom suite: every team dialog closes on Escape, background inert, no independent stacking, preview never renders under a modal, Close vs Cancel labels — in tests/team-ux-dialogs.test.tsx
- [X] T056 [P] [US6] Glossary enforcement test over both i18n bundles: forbidden tokens (incl. the placeholder title), canonical section labels, Close/Cancel key-role map — in tests/team-i18n-glossary.test.ts

**Checkpoint**: one product voice, one dialog behavior, honest states.

---

## Phase 9: User Story 7 - Фонова робота не тримає вікно (Priority: P7)

**Goal**: Batch processing survives its dialog; header chip + summary; explicit cancel. (FR-032; finding B1)

**Independent Test**: spec US7 — start batch, close dialog, chip counts on, reopen, summary toast on completion (partial failure listed), explicit confirmed cancel.

- [X] T057 [US7] Lift the claim loop into `LibraryProcessingProvider` (context idiom + test override; state machine idle/running/complete/failed/canceled per data-model §6; claim → context → heartbeat → complete/fail; lease release only on provider unmount; explicit `cancel()`), mounted per entered space — new apps/web/src/team/library/LibraryProcessingProvider.tsx, wired in apps/web/src/team/workspace/WorkspaceShell.tsx
- [X] T058 [US7] Turn `ProcessLibraryDialog` into a viewer over the provider (start/cancel-with-confirm/retry + progress; closing the dialog changes nothing about the run) in apps/web/src/team/library/ProcessLibraryDialog.tsx
- [X] T059 [US7] Background-work chip in the shell header (spinner + done/total, click opens the dialog) and the completion summary toast (successes, failures, failed items; partial failure never reads as success) in apps/web/src/team/workspace/WorkspaceShell.tsx and apps/web/src/styles.css
- [X] T060 [P] [US7] Suite: run continues across dialog close (mocked client), chip reflects progress, summary on NO_WORK, explicit cancel releases the attempt, provider unmount releases the lease — in tests/team-ux-background.test.tsx

**Checkpoint**: background work is background.

---

## Phase 10: Polish & Cross-Cutting

- [X] T061 [P] Session-scoped preview-URL cache (keyed by material id + variant) so re-renders stop re-fetching signed URLs in apps/web/src/team/library/LibraryAssetVisualPreview.tsx and apps/web/src/team/tasks/TaskAttachmentTile.tsx
- [X] T062 [P] Remove the dead drag-selection plumbing and its stale drop-target advertisement (spec keeps the full keyboard/drag model out of scope) in apps/web/src/team/catalog/MaterialBrowser.tsx, apps/web/src/team/tasks/TaskAttachmentPicker.tsx, and the orphaned i18n keys in apps/web/src/i18n.ts
- [X] T063 [P] Update docs/TEAM_WORKSPACE_OPERATIONS.md: leave/draft-delete/task-delete functions, trash view, background batch semantics, new audit action codes
- [X] T064 Run the full local gates and fix fallout: `npm run format:check`, `npm run lint`, `npm test`, `npm run build -w @video-compressor/web`, `npm run test:db`
- [X] T065 Manual quickstart pass (specs/010-team-ux-refresh/quickstart.md) through US1–US7 on the beta stack, including the SC-009 responsiveness spot-check on the weak reference machine; record outcomes in specs/010-team-ux-refresh/findings.md
- [ ] T066 Release precondition: confirm the web+Supabase deploy carries no unreleased `apps/agent`/`packages/shared` deltas (`npm run verify-release` preconditions) and the migration's reverse steps are in ROLLBACK.md
- [ ] T067 Finish the two halves of the quickstart pass this environment cannot reach (findings.md, "What this pass still could not cover"): US1.3/US2/US4 seen from a second signed-in account, and every Drive-dependent flow — rename, move, trash/restore, the 50-item search page, US7's background batch and the SC-009 spot-check — behind the opt-in OAuth test client from docs/BETA.md
- [ ] T068 Decide and land the two behaviours T065 left open: `/team` must be able to resolve to the lobby on an explicit "all spaces" intent (today the redirect re-arms the remembered space it just cleared, so the lobby and the create wizard are unreachable), and a realtime channel stuck in `connecting` must announce itself the way `reconnecting` does (FR-018) — apps/web/src/team/TeamSpace.tsx, apps/web/src/team/workspace/SpaceSwitcher.tsx, apps/web/src/team/useTeamRealtime.ts, apps/web/src/team/workspace/RealtimeChip.tsx
- [ ] T069 Say in docs/BETA.md's Start section that `beta:up` restores the database from a snapshot and does not replay pending migrations — only `beta:reset` does; a stale schema surfaces as a generic "something went wrong" toast on every lifecycle action

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none — start immediately (T001 needs only the beta stack).
- **Foundational (Phase 2)**: after Setup. Internal order: T003 → T004 can parallel; T008 → T009 → T010 → T011; T005/T006 parallel to everything except their own files; T007 after T006.
- **User stories (Phases 3–9)**: all require Phase 2. After that they are independently deliverable; the intended order is priority order US1 → US7.
- **Polish (Phase 10)**: after the stories you chose to ship.

### Story Dependencies (all soft — each story remains independently testable)

- **US1**: none beyond Foundational. Delivers the shell every later story renders into (later stories touch `WorkspaceShell` — coordinate merges, not correctness).
- **US2**: none hard. T021/T023 touch files US6 also edits (`ProcessMaterialDialog`, `TeamCatalog`) — sequence within a file, or rebase carefully.
- **US3**: uses toasts/mapper from Foundational only. T033 removes a prop US2's T021 also touches — trivial merge either order.
- **US4**: uses T010 wrappers (leave/draft-delete). Lobby edits (T036/T039) touch files US1's T018 edits — do US1 first (priority order already ensures it).
- **US5**: uses T010 (`deleteTask`, `listTrashedMaterials`) and the trash route from Foundational T006; the `/trash` section link lands in the shell (US1's tab bar) but renders standalone if US1 is skipped.
- **US6**: T049–T051 port dialogs US2/US3 also touch — within each file, later story edits win; the glossary tasks (T052/T053) should land after US1–US5 copy stabilizes.
- **US7**: independent of US2–US6; shares only the shell header (chip).

### Within Each Story

Implementation tasks in listed order (same-file tasks are sequential); the story's test suite ([P]) can be written alongside; the story is done when its suite and independent test pass.

---

## Parallel Example: after Foundational

```text
# Three independent workstreams once Phase 2 lands:
Stream A (navigation): T012 → T013 → T015 → T018, with T014/T016/T017/T019 in parallel
Stream B (backend-consuming): T036/T037 (US4 lobby) + T042/T043 (US5 trash) — different files
Stream C (feedback): T028–T034 (US3) — only T033/T034 touch the shell; coordinate with Stream A

# Inside US2, these run in parallel after T020:
T022 FolderPicker (new file) | T026 slash-focus (search bar) | T027 test suite
```

---

## Implementation Strategy

**MVP first (US1)**: Phases 1–2, then Phase 3, then validate US1 independently (tests/team-ux-navigation.test.tsx + quickstart US1). This alone delivers the navigation skeleton — the single highest-leverage fix.

**Incremental delivery**: ship story by story in priority order; every story leaves the app consistent (no story depends on a later one). A natural intermediate release point is after US3 (navigation + files + feedback = the daily-driver experience); US4–US7 complete the lifecycle, reversibility, consistency, and background layers.

**Merge-conflict awareness** (single developer, weak machine — sequential is fine): `WorkspaceShell.tsx` and `TeamCatalog.tsx` are touched by several stories; when working stories in parallel, land shell-touching tasks smallest-first.

---

## Notes

- Every task cites repo-relative paths; contracts live in specs/010-team-ux-refresh/contracts/.
- Machine codes stay stable (constitution V) — only rendering changes.
- All new SQL follows the 001 security template (`security definer`, `set search_path = ''`, narrow grants, audit rows).
- Commit after each task or logical group; keep `npm run format` clean as you go.
- Weak-hardware etiquette while implementing: run single test files (`npx vitest run tests/<file>`), not the whole suite, until T064.
