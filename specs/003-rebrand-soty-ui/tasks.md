# Tasks: Ізольований UI-ребрендинг Soty

**Input**: Design documents from `/specs/003-rebrand-soty-ui/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`,
`quickstart.md`, `design-tokens.json`

**Tests**: Included because the specification requires independently testable user stories,
zero-side-effect proof, measurable accessibility/reflow checks and moderated validation.

**Organization**: Tasks are grouped by user story so each story can be implemented and
validated as an independent increment. This phase creates only the local review copy; no
production integration, deployment or rollout task is authorized.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel after its phase prerequisites because it changes different files.
- **[Story]**: Maps a task to its user story (`US1`–`US4`).
- Every task names the exact target file or directory.

---

## Phase 1: Setup (Isolated Review Workspace)

**Purpose**: Create the physical build and dependency boundary without touching production UI.

- [X] T001 Create the isolated React/Vite workspace manifests and TypeScript project in `apps/soty-review/package.json`, `apps/soty-review/tsconfig.json`, and `apps/soty-review/tsconfig.node.json`
- [X] T002 Add pinned review workspace dependencies plus `dev:soty-review`, `build:soty-review`, `preview:soty-review`, and `verify:soty-review` commands in `package.json` and `package-lock.json`
- [X] T003 [P] Configure loopback-only servers, `envDir: false`, no proxy, strict ports, and the separate output directory in `apps/soty-review/vite.config.ts`
- [X] T004 [P] Create the review-only CSP document and React entrypoint in `apps/soty-review/index.html` and `apps/soty-review/src/main.tsx`
- [X] T005 [P] Add review artifact ignore rules without ignoring versioned baselines in `.gitignore`

**Checkpoint**: The empty review workspace builds separately and is absent from production build/deploy scripts.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the typed catalog, local state machine, token pipeline and enforceable
isolation boundary required by every story.

**⚠️ CRITICAL**: No user story implementation begins until this phase is complete.

### Foundation Tests

- [X] T006 [P] Write failing catalog uniqueness, canonical-state coverage, exclusion, and primary-state validation tests in `tests/soty-review-catalog.test.ts`
- [X] T007 [P] Write failing hash parse/serialize, untrusted-input validation, and invalid-route fallback tests in `tests/soty-review-routing.test.ts`
- [X] T008 [P] Write failing exhaustive transition, disabled no-op, and side-effect-free action tests in `tests/soty-review-reducer.test.tsx`
- [X] T009 [P] Write failing alias resolution, cycle detection, source-digest, generated-drift, and forbidden-color-literal tests in `tests/soty-review-tokens.test.ts`
- [X] T010 [P] Write failing forbidden-import, forbidden-browser-global, root-script, and production-output boundary tests in `tests/soty-review-isolation.test.ts`

### Foundation Implementation

- [X] T011 Define `ReviewCatalog`, surface/state IDs, coverage decisions, per-surface discriminated models, `DemoAction`, motif, review-reference, and approval types in `apps/soty-review/src/review/model.ts`
- [X] T012 Implement the initial single-source catalog registry, canonical state list, viewport matrix, and explicit scope exclusions in `apps/soty-review/src/review/catalog.ts`
- [X] T013 [P] Implement validated dependency-free hash parsing and serialization with explanatory catalog fallback in `apps/soty-review/src/review/router.ts`
- [X] T014 [P] Implement the exhaustive local demo reducer and review context with no browser/network/storage effects in `apps/soty-review/src/review/reducer.tsx`
- [X] T015 [P] Implement deterministic DTCG alias resolution and `--soty-*` CSS generation from `specs/003-rebrand-soty-ui/design-tokens.json` in `apps/soty-review/scripts/generate-tokens.mjs` and `apps/soty-review/src/generated/soty-tokens.css`
- [X] T016 [P] Create immutable synthetic people, teams, files, jobs, errors, long-copy, and empty-state fixture foundations in `apps/soty-review/src/review/fixtures/base.ts`
- [X] T017 Implement the review shell, catalog/screen resolver, navigation controls, theme/locale query state, and invalid-route notice in `apps/soty-review/src/ReviewApp.tsx` and `apps/soty-review/src/components/ReviewChrome.tsx`
- [X] T018 Enforce forbidden production imports and runtime globals for `apps/soty-review/**` in `eslint.config.mjs`

**Checkpoint**: Typed local navigation and token generation pass their tests; no review source can reach production runtime seams.

---

## Phase 3: User Story 1 — Переглянути ізольований концепт Soty (Priority: P1) 🎯 MVP

**Goal**: Let the owner browse every current in-app surface and relevant state using only
synthetic local transitions, with stable references for feedback and no effect on Wishly.

**Independent Test**: Start the review app, traverse every catalog entry/state, activate at
least 50 demo controls, and confirm stable `iteration/surface/state/element` references plus
zero auth, storage, processing, analytics, API, agent or external network activity.

### Tests for User Story 1

- [X] T019 [P] [US1] Write failing full-inventory and relevant-state coverage tests for FR-004, FR-005, FR-007, and SC-001 in `tests/soty-review-inventory.test.ts`
- [X] T020 [P] [US1] Write failing catalog navigation, direct-link, iteration label, stable `data-review-id`, and invalid-link recovery tests in `tests/soty-review-navigation.test.tsx`
- [X] T021 [P] [US1] Write the failing Playwright scenario that invokes at least 50 demo actions and rejects real/external requests for FR-002, FR-003, FR-006, and SC-002 in `apps/soty-review/scripts/verify-isolation.mjs`

### Implementation for User Story 1

- [X] T022 [P] [US1] Build synthetic auth-entry, profile-onboarding, global shell, connection, user-menu, support, update, feature-lock, and local-app overlay states in `apps/soty-review/src/screens/auth/AuthReview.tsx`, `apps/soty-review/src/screens/shell/ShellReview.tsx`, and `apps/soty-review/src/review/fixtures/auth-shell.ts`
- [X] T023 [P] [US1] Build authenticated tools-home and account/profile/invitation/release-status states in `apps/soty-review/src/screens/home/HomeReview.tsx`, `apps/soty-review/src/screens/account/AccountReview.tsx`, and `apps/soty-review/src/review/fixtures/home-account.ts`
- [X] T024 [P] [US1] Build compressor empty, populated, selection, job lifecycle, batch, settings, image-slot, success, failure, and disabled states in `apps/soty-review/src/screens/compressor/CompressorReview.tsx` and `apps/soty-review/src/review/fixtures/compressor.ts`
- [X] T025 [P] [US1] Build Landing Optimizer queue, batch, phase, asset, comparison, settings, warning, success, and error states in `apps/soty-review/src/screens/landing-optimizer/LandingOptimizerReview.tsx` and `apps/soty-review/src/review/fixtures/landing-optimizer.ts`
- [X] T026 [P] [US1] Build Landing Gallery welcome, catalog, viewer, tree/grid, search, rendering, stale, and error states in `apps/soty-review/src/screens/landing-gallery/LandingGalleryReview.tsx` and `apps/soty-review/src/review/fixtures/landing-gallery.ts`
- [X] T027 [P] [US1] Build transcription model-gate, download, queue/job, translation, transcript, media-preview, karaoke, success, and error states in `apps/soty-review/src/screens/transcription/TranscriptionReview.tsx` and `apps/soty-review/src/review/fixtures/transcription.ts`
- [X] T028 [P] [US1] Build Team lobby and create-space name/folder/resume/loading/error states in `apps/soty-review/src/screens/team/TeamLobbyReview.tsx`, `apps/soty-review/src/screens/team/CreateSpaceReview.tsx`, and `apps/soty-review/src/review/fixtures/team-entry.ts`
- [X] T029 [P] [US1] Build Team workspace catalog/search/preview/edit/process/operation states and settings/member/Drive/invitation/permission/ownership/audit states in `apps/soty-review/src/screens/team/TeamWorkspaceReview.tsx`, `apps/soty-review/src/screens/team/TeamSettingsReview.tsx`, and `apps/soty-review/src/review/fixtures/team-workspace.ts`
- [X] T030 [P] [US1] Build the Soty component showcase for buttons, controls, cards, modal, progress, badges, toast, logo, icons, and decoration in `apps/soty-review/src/screens/components/ComponentShowcase.tsx`
- [X] T031 [US1] Register all twelve surface groups, their canonical scenario-or-N/A coverage, fixtures, route hints, requirement links, and explicit exclusions in `apps/soty-review/src/review/catalog.ts`
- [X] T032 [US1] Complete catalog filtering, previous/next navigation, state chips, visible iteration ID, and stable feedback references in `apps/soty-review/src/components/ReviewCatalog.tsx`, `apps/soty-review/src/components/ReviewChrome.tsx`, and `apps/soty-review/src/ReviewApp.tsx`
- [X] T033 [US1] Implement the isolated preview server lifecycle, request interception, 50-action traversal, and guaranteed browser/context cleanup in `apps/soty-review/scripts/verify-review.mjs`

**Checkpoint**: User Story 1 is a complete reviewable MVP; stop here for an isolation and inventory review before visual refinement.

---

## Phase 4: User Story 2 — Швидко дійти до основної дії (Priority: P2)

**Goal**: Make the main action immediately identifiable and remove unnecessary intermediate
selection while keeping Soty decoration subordinate to task completion.

**Independent Test**: On home, a tool card and team workspace, card and CTA reach the same
next demo state; each local group has at most one solid honey CTA and decoration adds no
focus target, click target or step.

### Tests for User Story 2

- [X] T034 [P] [US2] Write failing primary-action hierarchy, single-honey-CTA, whole-card destination parity, and decorative non-interaction tests for FR-021–FR-023 in `tests/soty-review-primary-action.test.tsx`
- [X] T035 [P] [US2] Write failing five-screen timed-review scenario definitions for SC-004 and SC-005 in `tests/soty-review-usability-scenarios.test.ts`

### Implementation for User Story 2

- [X] T036 [P] [US2] Implement primary, secondary, ghost, disabled, status, and direct-link card primitives with FR-010–FR-012 and FR-019–FR-020 token roles in `apps/soty-review/src/components/Action.tsx`, `apps/soty-review/src/components/Card.tsx`, and `apps/soty-review/src/styles.css`
- [X] T037 [P] [US2] Apply one-step card/CTA navigation and dominant-action hierarchy to the tools home in `apps/soty-review/src/screens/home/HomeReview.tsx`
- [X] T038 [P] [US2] Apply direct next-step hierarchy to compressor, landing, transcription, and team-workspace representative flows in `apps/soty-review/src/screens/compressor/CompressorReview.tsx`, `apps/soty-review/src/screens/landing-optimizer/LandingOptimizerReview.tsx`, `apps/soty-review/src/screens/transcription/TranscriptionReview.tsx`, and `apps/soty-review/src/screens/team/TeamWorkspaceReview.tsx`
- [X] T039 [P] [US2] Implement pointer-transparent, unfocusable honeycomb/bee/honey motifs with matte purple surfaces and family-safe gradients for FR-014–FR-017 in `apps/soty-review/src/components/SotyMotifs.tsx` and `apps/soty-review/src/styles.css`
- [X] T040 [US2] Link primary-action and timed usability scenarios to every representative catalog state in `apps/soty-review/src/review/catalog.ts`

**Checkpoint**: User Story 2 can be tested without opening any advanced settings or relying on another visual story.

---

## Phase 5: User Story 3 — Простий UI та доступні складні налаштування (Priority: P3)

**Goal**: Keep safe defaults and consequences visible while advanced controls remain
discoverable through contextual disclosure or a clearly nested level.

**Independent Test**: Complete a basic demo flow without expanding settings, then open,
change and collapse one requested advanced option; nested flows retain safe choices and show
context/back navigation, while confirmation always shows target and consequence.

### Tests for User Story 3

- [X] T041 [P] [US3] Write failing safe-default, discoverable-disclosure, expand/change/collapse, and base-flow tests for FR-024–FR-026 and SC-006 in `tests/soty-review-disclosure.test.tsx`
- [X] T042 [P] [US3] Write failing nested-context, back-navigation state preservation, confirmation consequence, and lifecycle-state tests for FR-025 and FR-027–FR-031 in `tests/soty-review-nested-flow.test.tsx`

### Implementation for User Story 3

- [X] T043 [P] [US3] Implement accessible disclosure, nested-page heading, breadcrumb/back, summary, and confirmation primitives in `apps/soty-review/src/components/Disclosure.tsx`, `apps/soty-review/src/components/NestedLevel.tsx`, and `apps/soty-review/src/components/Confirmation.tsx`
- [X] T044 [P] [US3] Recompose compressor defaults, output/image settings, and final action consequence around progressive disclosure in `apps/soty-review/src/screens/compressor/CompressorReview.tsx`
- [X] T045 [P] [US3] Recompose Landing Optimizer quality/archive controls and comparison detail into contextual disclosure in `apps/soty-review/src/screens/landing-optimizer/LandingOptimizerReview.tsx`
- [X] T046 [P] [US3] Recompose transcription language/model/translation/media controls with visible current choices and nested return paths in `apps/soty-review/src/screens/transcription/TranscriptionReview.tsx`
- [X] T047 [P] [US3] Recompose Team workspace search/settings/metadata/process and permission/ownership confirmations without hiding target or consequence in `apps/soty-review/src/screens/team/TeamWorkspaceReview.tsx` and `apps/soty-review/src/screens/team/TeamSettingsReview.tsx`
- [X] T048 [US3] Register basic, advanced, nested, return, confirmation, and all applicable lifecycle scenarios in `apps/soty-review/src/review/catalog.ts`

**Checkpoint**: User Story 3 independently demonstrates both the simple default path and expert control path.

---

## Phase 6: User Story 4 — Цілісний та доступний Soty-досвід (Priority: P4)

**Goal**: Make every representative state coherent in both themes, keyboard-operable,
WCAG 2.2 AA-compliant, reduced-motion safe, long-content safe and reflowable to 320 CSS px.

**Independent Test**: Run the automated theme/viewport/reduced-motion/axe matrix, then
complete representative paths using keyboard only and real 200% browser zoom without lost
content, horizontal main-flow scrolling, invisible focus or decoration overlap.

### Tests for User Story 4

- [X] T049 [P] [US4] Extend token tests with computed foreground/surface, border, focus, hover, disabled, and status contrast thresholds for FR-009, FR-013, FR-020, and FR-034 in `tests/soty-review-tokens.test.ts`
- [X] T050 [P] [US4] Write failing accessible-name, semantic-state, color-independent status, decorative exclusion, modal focus trap/restore/Escape, and keyboard-order tests for FR-035–FR-036 in `tests/soty-review-accessibility.test.tsx`
- [X] T051 [P] [US4] Write failing reduced-motion fallback and animation-independent progress tests for FR-031 and FR-037 in `tests/soty-review-motion.test.tsx`
- [X] T052 [P] [US4] Add failing Playwright viewport, long-content, overflow, focus-visibility, and overlap assertions for FR-033 and FR-038 in `apps/soty-review/scripts/verify-layout.mjs`

### Implementation for User Story 4

- [X] T053 [P] [US4] Implement preview-scoped light/dark theme selection, URL determinism, system fallback, `color-scheme`, and safe theme transition handling in `apps/soty-review/src/review/theme.ts` and `apps/soty-review/src/ReviewApp.tsx`
- [X] T054 [US4] Add explicitly reviewable success/warning/error proposal roles and accessible ready/active/development treatments without altering normative primitives in `apps/soty-review/src/review/visual-proposals.ts` and `apps/soty-review/src/styles.css`
- [X] T055 [US4] Implement native/APG keyboard behavior, opaque or dual focus rings, modal inertness, disabled explanations, and live status semantics in `apps/soty-review/src/components/Controls.tsx`, `apps/soty-review/src/components/Modal.tsx`, and `apps/soty-review/src/styles.css`
- [X] T056 [US4] Implement fluid 320px reflow, wrapping/truncation with full-value access, long-card resilience, and decoration-first hiding in `apps/soty-review/src/styles.css` and `apps/soty-review/src/review/fixtures/long-content.ts`
- [X] T057 [US4] Implement global reduced-motion overrides and static indeterminate-progress meaning in `apps/soty-review/src/styles.css` and `apps/soty-review/src/components/Progress.tsx`
- [X] T058 [P] [US4] Implement the reviewable honey-mark/purple-or-neutral Soty wordmark direction and theme-safe volumetric motifs for FR-018 in `apps/soty-review/src/components/SotyLogo.tsx` and `apps/soty-review/src/components/SotyMotifs.tsx`
- [X] T059 [US4] Extend the browser verifier with light/dark, reduced-motion, axe, screenshot naming, and five-viewport coverage in `apps/soty-review/scripts/verify-review.mjs`
- [X] T060 [US4] Register theme, locale, viewport, reduced-motion, long-content, keyboard, and contrast evidence dimensions for every approval surface in `apps/soty-review/src/review/catalog.ts`

**Checkpoint**: User Story 4 produces complete automated evidence and is ready for manual 200%-zoom and owner review.

---

## Phase 7: Polish, Evidence & Approval Gate

**Purpose**: Validate cross-story integrity, record human evidence and stop at the written
visual approval boundary.

- [X] T061 [P] Add the Soty-only customer-text scan with explicit before/after exceptions for FR-001, FR-032, and SC-003 in `tests/soty-review-branding.test.ts`
- [X] T062 [P] Add production bundle/script regression checks proving review code is absent from `apps/web/dist`, deploy, package, release, and manifest flows in `tests/soty-review-production-boundary.test.ts`
- [X] T063 Capture deterministic light/dark/reduced-motion baselines named by iteration, surface, state, theme, and viewport in `specs/003-rebrand-soty-ui/review/soty-ui-r01/baselines/`
- [ ] T064 Record keyboard-only, actual contrast-pair, 320px reflow, long-copy, decoration-overlap, and real 200%-zoom results for SC-007 and SC-008 in `specs/003-rebrand-soty-ui/review/soty-ui-r01/accessibility-matrix.md`
- [ ] T065 Conduct the 20-participant five-screen primary-action and time-to-tool study for SC-004 and SC-005 and record results in `specs/003-rebrand-soty-ui/review/soty-ui-r01/usability-primary-actions.md`
- [ ] T066 Conduct the 20-participant basic-flow and advanced-setting discoverability study for SC-006 and record results in `specs/003-rebrand-soty-ui/review/soty-ui-r01/usability-disclosure.md`
- [ ] T067 Collect the clarity/non-overload and recognizable-Soty-motifs ratings for SC-009 in `specs/003-rebrand-soty-ui/review/soty-ui-r01/usability-perception.md`
- [ ] T068 Run every command and expected outcome from `specs/003-rebrand-soty-ui/quickstart.md` and record the immutable evidence index in `specs/003-rebrand-soty-ui/review/soty-ui-r01/verification.md`
- [ ] T069 Present all blocking decisions and both-theme/responsive/logo evidence to the owner, pause for written approval, and record the SC-010 gate without starting integration in `specs/003-rebrand-soty-ui/review/soty-ui-r01/approval.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 — Setup**: No dependencies; starts immediately.
- **Phase 2 — Foundational**: Depends on Phase 1 and blocks every user story.
- **Phase 3 — US1 (P1)**: Depends on Phase 2; delivers the independently reviewable MVP.
- **Phase 4 — US2 (P2)**: Depends on Phase 2 and uses the catalog/screens established by
  US1 in the sequential path. Its hierarchy components and tests can be developed in
  parallel against fixtures after the foundation.
- **Phase 5 — US3 (P3)**: Depends on Phase 2 and uses representative screens from US1;
  disclosure primitives/tests can proceed in parallel after the foundation.
- **Phase 6 — US4 (P4)**: Depends on Phase 2; cross-surface application completes after
  the desired US1–US3 surfaces exist.
- **Phase 7 — Evidence/Approval**: Depends on all four selected user stories. T069 is a hard
  human gate and authorizes only a future planning phase, never production integration.

### User Story Dependency Graph

```text
Setup -> Foundation -> US1 (reviewable inventory/MVP)
                    ├-> US2 (primary-action hierarchy)
                    ├-> US3 (progressive disclosure)
                    └-> US4 (themes/accessibility foundation)

US1 + US2 + US3 + US4 -> Evidence matrix -> Written owner approval
```

### Within Each User Story

- Write the story tests first and verify they fail for the intended reason.
- Implement typed fixtures/models before composing the screens that consume them.
- Implement shared story primitives before applying them across representative screens.
- Complete and run the independent test before proceeding to the next priority.
- Never satisfy a review task by importing a live production component or provider.

---

## Parallel Opportunities

### User Story 1

After T019–T021 are written and foundation is complete, T022–T030 touch separate surface
files and can run in parallel. T031–T033 integrate their outputs afterward.

```text
T022 auth/shell     T023 home/account      T024 compressor
T025 landing opt.   T026 landing gallery   T027 transcription
T028 team entry     T029 team workspace    T030 component showcase
```

### User Story 2

T034 and T035 can run in parallel; after T036, screen-specific T037–T039 can proceed in
parallel before T040 updates the catalog mappings.

### User Story 3

T041 and T042 can run in parallel. After T043, T044–T047 can proceed in parallel before
T048 integrates the scenarios.

### User Story 4

T049–T052 can run in parallel. T053 and T058 can run in parallel; sequence T054–T057
because they share `styles.css`, then finish T059–T060.

---

## Implementation Strategy

### MVP First — User Story 1

1. Complete Phase 1 and Phase 2.
2. Complete T019–T033 for US1.
3. Run the US1 inventory/navigation/isolation tests independently.
4. Stop and review the complete, inert catalog before visual refinement.
5. Do not deploy; the MVP is a loopback-only review artifact.

### Incremental Delivery

1. **Foundation**: isolated build + typed catalog + reducer + generated tokens.
2. **US1**: complete inert screen/state inventory with stable review references.
3. **US2**: validate primary-action hierarchy and one-step navigation.
4. **US3**: validate safe defaults, disclosure and nested confirmations.
5. **US4**: validate themes, accessibility, motion, reflow and long content.
6. **Evidence**: run automation and human studies, iterate on blocking feedback.
7. **Approval**: record written owner decision and stop; use a new spec/plan for integration.

### Parallel Team Strategy

After shared setup/foundation, separate contributors may own screen families (tools, team,
auth/account), hierarchy/disclosure primitives, and accessibility harnesses. Changes to
`apps/soty-review/src/styles.css`, `apps/soty-review/src/review/catalog.ts`, and
`apps/soty-review/scripts/verify-review.mjs` require sequencing to avoid conflicts.

---

## Notes

- `[P]` means the task has no dependency on another incomplete task in the same phase and
  primarily changes distinct files; shared-file edits are intentionally sequenced.
- User-story labels provide direct traceability to the four prioritized stories.
- Test tasks precede implementation tasks and must fail for the expected missing behavior.
- All UI content and assets are synthetic; no production export is allowed.
- Keep TypeScript strict and `any`-free, internal ESM imports explicit, and use class-based
  styling with scoped CSS variables.
- T069 is intentionally not automatable: an implementation agent cannot grant product-owner
  approval or broaden this feature into production integration.
