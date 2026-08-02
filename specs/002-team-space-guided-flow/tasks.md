---
description: "Task list for feature implementation: Спрощений покроковий інтерфейс командного простору"
---

# Tasks: Спрощений покроковий інтерфейс командного простору

**Input**: Design documents from `/specs/002-team-space-guided-flow/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: INCLUDED. The repo's quality gate requires `npm test` to pass, and plan.md +
quickstart.md enumerate DOM test files for this feature. Test tasks are therefore part of each
story.

**Organization**: Tasks are grouped by user story (US1, US2, US3) to enable independent
implementation and testing. This is a **frontend-only re-composition** of
`001-team-media-workspace`: no new RPC, Edge Function, table, migration, or shared contract
(the only possible shared touch is one optional analytics event name — T029).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 / US2 / US3 (setup, foundational, and polish tasks carry no story label)
- Exact file paths are included in every task.

## Path Conventions

Web app in an existing monorepo; all paths are repo-relative. Web source lives under
`apps/web/src/`, tests under `tests/` (central, `*.test.tsx` with a `// @vitest-environment jsdom`
docblock).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish a green baseline before changing anything.

- [X] T001 Establish a green baseline: run `npm run format:check`, `npm run lint`, `npm test`, and `npm run build -w @video-compressor/web`; record any pre-existing failures so they are not attributed to this feature.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The entered-space state model, the `/team` resolver, and the shared i18n keys.
Every user story depends on these.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Replace the passive active-team selection with an explicit nullable *entered space* in `apps/web/src/team/TeamContext.tsx`: drop the `?? teams[0]` fallback in the `activeTeam` derivation; add `enterSpace(id)` (validate membership in `teams`, persist to `wishly.active-team.v1`) and `leaveSpace()` (set null, clear storage); on load, clear a persisted id not present in `teams`; keep the existing membership-lost handler clearing the entered space. Extend `TeamContextValue` (and `TeamContextOverride` usage) with `enterSpace`/`leaveSpace` and a derived `enteredSpace`/`hasEnteredSpace`. (data-model §1)
- [X] T003 [P] Add all new compile-checked `TranslationKey`s for the lobby, create wizard, space settings, and shell copy to both `en` and `uk` maps in `apps/web/src/i18n.ts` (e.g. space picker title, "Create a new space", "Continue setup", "Space is being set up", wizard step labels, "Change space", "Space settings", empty-space copy). Plain, non-technical wording. (FR-018)
- [X] T004 Create the `/team` resolver `apps/web/src/team/TeamSpace.tsx` that reads `TeamContext` and renders exactly one surface — lobby vs create wizard vs workspace shell — per the resolution table in `contracts/navigation-and-lobby.md`. Stub the three surfaces initially (filled by US1/US2/US3). (Depends on T002)
- [X] T005 Swap the route in `apps/web/src/ProtectedWishly.tsx`: `path === '/team'` renders `<TeamSpace/>` instead of `<TeamWorkspacePage/>`; update imports. (Depends on T004)

**Checkpoint**: `/team` mounts the resolver; entered-space state is authoritative.

---

## Phase 3: User Story 1 - Увійти та обрати простір (Priority: P1) 🎯 MVP

**Goal**: A prominent home entry leads to a simple space lobby; selecting a space enters and
caches it; a saved choice skips the lobby; "Change space" returns to it.

**Independent Test**: As a user with ≥1 existing team, open the Team Space entry from home →
see the lobby → select a space → land in it → reopen `/team` and arrive directly (cache) →
"Change space" → back to the lobby → pick another.

### Implementation for User Story 1

- [X] T006 [P] [US1] Create `apps/web/src/team/lobby/SpaceCard.tsx` rendering a team as a simple card with `ready` | `setup_incomplete` | `preparing` variants derived from `connectionState` per data-model §2 (enterable / "Continue setup" owner-only / read-only "Space is being set up"). Keyboard-operable (`role="button"`, Enter/Space).
- [X] T007 [US1] Create `apps/web/src/team/lobby/SpaceLobby.tsx`: list the user's teams as `SpaceCard`s plus a single "Create a new space" action, and a welcoming empty state (no teams) whose primary action starts creation; no management panels or filters. (FR-002, FR-006; depends on T006)
- [X] T008 [US1] Create a minimal `apps/web/src/team/workspace/WorkspaceShell.tsx`: shows the entered space's name, an always-available "Change space" control wired to `leaveSpace()`, and a placeholder content region (enriched in US3). (FR-005)
- [X] T009 [US1] Wire the resolver in `apps/web/src/team/TeamSpace.tsx`: render `SpaceLobby` when no space is entered and the minimal `WorkspaceShell` when one is; call `enterSpace(id)` on selecting a `ready` card; fire the existing `trackTeamWorkspaceSession()` once per entered space; clear an invalid cached selection to the lobby. (FR-003, FR-004, FR-007; depends on T007, T008)
- [X] T010 [US1] Ensure a prominent, labelled, keyboard-operable Team Space entry to `/team` on the home screen in `apps/web/src/HomePage.tsx` (retain/elevate the existing launcher card). (FR-001)
- [X] T011 [US1] Add lobby, space-card, and minimal-shell styles to `apps/web/src/styles.css` using `className` + CSS custom properties (no inline static styles); readable on narrow/zoomed viewports without horizontal scroll. (FR-021)
- [X] T012 [P] [US1] DOM test `tests/team-space-lobby.test.tsx`: entry resolves to lobby; cards render by readiness; selecting a `ready` card enters that space; empty state leads to create; "Change space" returns to the lobby. Use `TeamContextOverride` + injected client stub.
- [X] T013 [P] [US1] DOM test `tests/team-space-cache.test.tsx`: a valid persisted selection opens the workspace directly (no lobby); an invalid/missing selection falls back to the lobby without error.

**Checkpoint**: US1 fully functional and independently testable (navigation skeleton + cache).

---

## Phase 4: User Story 2 - Створити простір за кілька простих кроків (Priority: P1)

**Goal**: A linear name → folder → done wizard with required fields; completion lands in the
new space; abandoned setup is resumable and never shown as a ready space.

**Independent Test**: Start create → cannot advance without a valid name → cannot finish
without a connected folder → finish → land in the new space; separately, abandon mid-way and
confirm the space appears only as "Continue setup".

### Implementation for User Story 2

- [X] T014 [P] [US2] Create `apps/web/src/team/create/SpaceNameStep.tsx`: required name input reusing the existing normalization/length rule (NFC, collapse whitespace, 1…120); block "Continue" while invalid; on continue call `teamApi.createTeam(name)` and surface `NAME_CONFLICT` in place. (FR-009; contracts/create-space-wizard §Step 1)
- [X] T015 [P] [US2] Create `apps/web/src/team/create/ConnectFolderStep.tsx`: wrap the existing drive-connect sub-flow (`startDriveOAuth` → `listFolders('root')` → `DriveFolderBrowser` → `confirmDriveRoot` two-phase) for the new `teamId`; block completion until `connected`; surface `OAUTH_APPROVAL_REQUIRED` (and the `?drive=OAUTH_APPROVAL_REQUIRED` callback) as plain-language, non-completing. (FR-010, FR-013; contracts/create-space-wizard §Step 2)
- [X] T016 [US2] Create `apps/web/src/team/create/CreateSpaceWizard.tsx`: the linear step machine `name → folder → done` with visible progress and one primary action per step; bracket the flow with the existing `startTeamOnboardingFlow`/`completeTeamOnboardingFlow` analytics; on `done` call `enterSpace(newTeamId)`. (FR-008, FR-011, FR-012; depends on T014, T015)
- [X] T017 [US2] Wire the wizard into `apps/web/src/team/TeamSpace.tsx`: the lobby "Create a new space" action opens the wizard, and selecting a `setup_incomplete` card resumes the wizard at the folder step for that team. (Depends on T016; touches the resolver after T009)
- [X] T018 [US2] Add wizard step/progress styles to `apps/web/src/styles.css` (no inline static styles; accessible focus, no horizontal scroll on narrow/zoomed viewports). (FR-021)
- [X] T019 [P] [US2] DOM test `tests/create-space-wizard.test.tsx`: name required to advance; folder required to finish; completion enters the new space; abandoning leaves a resumable `setup_incomplete` space (never a ready one); `OAUTH_APPROVAL_REQUIRED` blocks completion with an explanation.

**Checkpoint**: US1 and US2 both work; a user can create a space end-to-end and enter it.

---

## Phase 5: User Story 3 - Працювати у спрощеному, просторому робочому екрані (Priority: P2)

**Goal**: Content-first workspace by default (no filters, no side panels); all 001 management
behind one "Space settings" surface; search/filters revealed on demand and content-aware.

**Independent Test**: Open an empty space → zero filters and zero side panels; open Space
settings → find members/invitations/drive/audit, each permission-gated; add materials →
search reveals only facets that exist.

### Implementation for User Story 3

- [X] T020 [P] [US3] Create `apps/web/src/team/workspace/SpaceSettings.tsx`: a dedicated sub-view re-parenting the existing 001 components unchanged — `members/MemberList` (including its role/permission and ownership controls `members/MemberPermissionsDialog` and `members/OwnershipTransferDialog`), `members/InvitationPanel`, `drive/DriveConnectionPanel` (owner), `members/TeamAuditPanel` (owner/admin) — each shown per its existing permission gate. Roles are managed via `MemberList`, not a separate panel. (FR-016, FR-019, FR-020; contracts/workspace-shell-and-disclosure)
- [X] T021 [US3] Enrich `apps/web/src/team/workspace/WorkspaceShell.tsx`: make `catalog/MaterialBrowser` the central default element; header carries space name, "Change space", a "Space settings" entry (opens T020), and a search/filter toggle shown only when there is content; manage a `content | settings | search` view state. (FR-014, FR-015; depends on T008, T020)
- [X] T022 [US3] Update `apps/web/src/team/catalog/TeamCatalog.tsx`: do not render `CatalogSearchBar`/`CatalogFilters` on mount; reveal search via the shell toggle; keep `useCatalogSearch`/`searchCatalog`/`getCatalogVocabulary` unchanged. (FR-017)
- [X] T023 [US3] Update `apps/web/src/team/catalog/CatalogFilters.tsx`: render only when the catalog has ≥1 material and the returned facet vocabulary is non-empty; render nothing for an empty space. (FR-017, SC-004)
- [X] T024 [US3] Add full workspace-shell, space-settings sub-view, and revealed-search styles to `apps/web/src/styles.css` (no inline static styles; accessible, no horizontal scroll of primary content). (FR-021)
- [X] T025 [P] [US3] DOM test `tests/workspace-shell.test.tsx`: a freshly created empty space renders zero filter controls and zero side management panels; the search toggle appears only with content.
- [X] T026 [P] [US3] DOM test `tests/space-settings.test.tsx`: every 001 capability (members, invitations, drive, audit) is reachable in ≤ 2 actions from the shell and is hidden when the viewer lacks the permission.
- [X] T027 [US3] Update `tests/team-workspace.test.tsx` to the new shell composition (replace assertions against the old all-panels grid with the content-first shell + settings surface).

**Checkpoint**: All three stories independently functional; the workspace is decluttered.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Remove superseded UI, optional telemetry, and final verification.

- [X] T028 Remove the superseded `apps/web/src/team/TeamWorkspacePage.tsx`, `apps/web/src/team/TeamSwitcher.tsx`, and `apps/web/src/team/CreateTeamDialog.tsx`, plus any dangling imports/exports (e.g. `apps/web/src/team/index.ts`) and test references. (Do only after T005/T017/T027 no longer reference them.)
- [X] T029 [P] OPTIONAL (Decision 7): if lobby/selection funnel measurement is wanted, add a single event name to `TeamAnalyticsEventName` in `packages/shared/src/team/analytics.ts` with typed props and rebuild shared (`npm run build -w @video-compressor/shared`); emit it from `enterSpace`/lobby view. Otherwise skip — existing onboarding/session events suffice.
- [X] T030 Accessibility & responsive sweep across the lobby, wizard, and shell: keyboard operability, visible focus, labelled controls, and no horizontal scroll of primary content on narrow/zoomed viewports. (FR-021)
- [X] T031 Run the full gate and quickstart validation: `npm run format:check`, `npm run lint`, `npm test`, `npm run build -w @video-compressor/web`, then the manual walkthrough in `specs/002-team-space-guided-flow/quickstart.md` (scenarios 1–3). Confirm the tree stays `any`-free and no new backend surface was introduced.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none — start immediately.
- **Foundational (Phase 2)**: after Setup — BLOCKS all user stories. Internal order: T002 →
  T004 → T005; T003 is independent `[P]` of T002.
- **User Stories (Phase 3–5)**: all depend on Foundational. US1 and US2 are both P1 and share
  the `TeamSpace` resolver (T009 then T017) and `WorkspaceShell` (T008 then T021), so they are
  best done in listed order rather than fully parallel. US3 (P2) builds on the US1 minimal
  shell.
- **Polish (Phase 6)**: after the stories it cleans up (T028 after T027).

### User Story Dependencies

- **US1 (P1)**: after Foundational. Independent (uses existing teams; empty-state → create is
  a placeholder until US2).
- **US2 (P1)**: after Foundational; wires into the resolver produced by US1 (T017 follows T009).
- **US3 (P2)**: after Foundational; enriches the US1 minimal shell (T021 follows T008).

### Within Each User Story

- Leaf components before the composite that uses them (SpaceCard → SpaceLobby; name/folder
  steps → wizard; SpaceSettings → enriched shell).
- Resolver/shell wiring after the surface components exist.
- Styles and tests alongside the surface they cover.
- Same-file tasks are sequential, not parallel: `styles.css` (T011 → T018 → T024),
  `TeamSpace.tsx` (T004 → T009 → T017), `WorkspaceShell.tsx` (T008 → T021), `i18n.ts` (T003).

### Parallel Opportunities

- T003 `[P]` runs alongside T002 in Foundational.
- US1: T006 `[P]`; tests T012/T013 `[P]` once their surfaces exist.
- US2: T014 `[P]` and T015 `[P]` (different files); test T019 `[P]`.
- US3: T020 `[P]`; tests T025/T026 `[P]`.
- T029 `[P]` in Polish.

---

## Parallel Example: User Story 2

```bash
# The two wizard steps are different files with no dependency on each other:
Task: "Create SpaceNameStep.tsx (required name, createTeam on advance)"      # T014
Task: "Create ConnectFolderStep.tsx (reuse drive-connect flow, required)"    # T015
# Then compose them:
Task: "Create CreateSpaceWizard.tsx step machine name → folder → done"       # T016
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1 Setup → Phase 2 Foundational (T002–T005).
2. Phase 3 US1 (T006–T013).
3. **STOP and VALIDATE**: a user with existing teams can find the entry, pick a space, get the
   cache skip, and change space. This is a demoable MVP of the new navigation.

### Incremental Delivery

1. Foundation ready (T002–T005).
2. + US1 → navigation & lobby (MVP).
3. + US2 → guided creation (a first-time user can create and enter a space end-to-end).
4. + US3 → decluttered, content-first workspace with progressive disclosure.
5. Polish → remove superseded UI, optional telemetry, a11y sweep, full gate.

### Notes

- `[P]` = different files, no incomplete dependencies. `[Story]` maps a task to its user story.
- No backend changes: reuse the 001 `teamApi` methods listed in `contracts/reused-backend.md`.
- Keep the tree `any`-free; add i18n keys to both `en` and `uk`; brand/design-system reuse
  only. Commit after each task or logical group.
- Known debt (see spec Assumptions): an abandoned wizard leaves a folderless "setup-incomplete"
  team with no delete path (001 has no delete-team RPC). It is never shown as ready; true
  cleanup/deletion is a separate follow-up, out of scope here.
