---
description: 'Task list for the Release Hardening Pass'
---

# Tasks: Release Hardening Pass

**Input**: Design documents from `/specs/009-release-hardening-pass/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [findings.md](./findings.md)

**Tests**: Test tasks are included throughout, because this feature _is_ about test coverage and verification. They are not optional here.

**Organization**: Grouped by user story so each can be implemented, tested and shipped independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel — different files, no dependency on an incomplete task
- **[Story]**: `US1`…`US7`, mapping to the user stories in spec.md
- Every task names an exact file path

## Path Conventions

npm-workspaces monorepo. `apps/agent/src/` (local app), `apps/web/src/` (interface), `packages/shared/src/` (contract), `tests/` (all tests, centralised — never co-located), `scripts/` (release and verification), `supabase/functions/` (backend).

## Finding references

`A1`–`A18`, `B1`–`B14`, `C1`–`C21`, `D1`–`D12`, `E1`–`E9`, `F1`–`F15` refer to entries in [findings.md](./findings.md). Anything labelled there as _inferred_ or _hypothesis_ must be reproduced before it is fixed — see T001.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Unblock everything else. The type-check gate is a hard prerequisite of SC-003 and is therefore first; the dependency upgrades mean every later change lands on a clean tree.

- [ ] T001 Reproduce every finding labelled _inferred_ or _hypothesis_ in `specs/009-release-hardening-pass/findings.md` §D by hand in a browser against the beta stack, following `specs/009-release-hardening-pass/quickstart.md` §0, and rewrite each entry's confidence label to record what was actually observed; retract any that does not reproduce
- [x] T002 [P] Add `engines` (`node >=22.12 <25`) to `package.json` and create `.nvmrc` at the repository root
- [x] T003 [P] Create `tsconfig.check.json` at the repository root covering `tests/**`, with bundler-style resolution and a header comment stating that source keeps explicit `.js` specifiers enforced by the three existing configs
- [x] T004 [P] Create `tests/types/deno.d.ts` declaring the backend runtime globals the test tree references
- [x] T005 [P] Create `tsconfig.scripts.json` at the repository root covering `scripts/**/*.mjs` with `checkJs`, `noImplicitAny: false`, `strictNullChecks: true`
- [x] T006 Widen the branded-identifier parameter in `tests/helpers.ts` so plain strings are accepted, clearing the ~65 systematic errors this single signature causes
- [x] T007 Add file exclusion lists to `tsconfig.check.json` and `tsconfig.scripts.json` naming today's remaining failures, so both gates are green on day one
- [x] T008 Create `tests/typecheck-ratchet.test.ts` asserting the exclusion lists in both configs never grow
- [x] T009 Add a `typecheck` script to `package.json` running all six projects (shared, agent, web, review app, check, scripts)
- [x] T010 [P] Fix the six real type errors this gate surfaces in `supabase/functions/_shared/drive.ts`, `supabase/functions/drive-connect/handler.ts` and `supabase/functions/library-ops/handler.ts`
- [x] T011 [P] Fix the possibly-undefined and wrong-union defects the scripts gate surfaces, starting with `scripts/fetch-windows-inputs.mjs` and `scripts/generate-team-contract-sql.mjs`
- [x] T012 Upgrade the four vulnerable dependencies in `package.json` and `apps/*/package.json` (the routing framework for the patched URI parser, the brace expander, the build toolchain for the id generator and CSS processor) and refresh `package-lock.json` (SC-011)
- [x] T013 [P] Create `audit-exceptions.json` at the repository root with the dated-exception shape from [data-model.md §9](./data-model.md)
- [x] T014 Add an `--out <dir>` flag to `scripts/generate-team-contract-sql.mjs` and change `tests/team-contract.test.ts` to generate into a temp directory, so the suite stops rebuilding the shared package output and rewriting a tracked migration mid-run (A17)

### Confirmed-live security holes (moved here from User Story 5)

These four close holes confirmed by **probing a running local app**, not inferred. They are cheap, independent, and must not wait behind six phases of other work. Their tests live with User Story 5 (T144, T147).

- [x] T014a Replace the four origin and token checks in `apps/agent/src/server/app.ts` with one request-admission hook registered first, applying to every path, ordered host → origin and fetch-metadata → token → failure counter, per [contracts/agent-http.md §1](./contracts/agent-http.md) (C5, FR-023)
- [x] T014b Use the existing constant-time comparison for the session token in `apps/agent/src/server/app.ts` and reject a non-string value before comparing — a repeated query parameter yields an array and reaches the raw comparison today (C4, FR-024)
- [x] T014c Configure the logger in `apps/agent/src/server/app.ts` to emit the route pattern rather than the raw URL, redact the token and redirect-location headers, and scrub any remaining 64-hex string; land this **before** any later task starts emitting new log lines (C10, FR-029)
- [x] T014d Invert the multipart default in `apps/agent/src/server/app.ts` from effectively unbounded to 32 MiB and opt each upload route into its own limit, so a route that forgets to specify is safe rather than open (C8, FR-027)

**Checkpoint**: Every file in the repository is type-checked, the dependency tree is clean, the suite no longer mutates the working tree, and the two live-confirmed request-admission holes are closed.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared mechanisms every story below depends on — the lifecycle declaration, the independent observation harness, and the test fixtures that today are copy-pasted or missing entirely.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Shared test support

- [x] T015 [P] Create `tests/support/wait.ts` with the single adaptive polling helper, replacing the six near-identical local copies (FR-021, FR-022)
- [x] T016 [P] Create `tests/support/requires.ts` with collection-time binary and path probes, `describeRequiring`, and the release-mode flag that makes a missing requirement throw instead of skip (FR-016)
- [x] T017 Replace the fourteen `if (!available) return;` sites with `describeRequiring` in `tests/real-ffmpeg.test.ts`, `tests/embedded-ffmpeg.test.ts`, `tests/static-edges.test.ts`, `tests/long-embedding.manual.test.ts` and `tests/soty-review-production-boundary.test.ts` (B3)
- [x] T018 Add a local lint rule to `eslint.config.mjs` banning a bare early return as a conditional's consequent inside a test callback under `tests/**`
- [x] T019 [P] Create `tests/support/machine-probe.ts` implementing liveness by syscall, the `(pid, creationTime)` tuple, the per-platform full process table walk, and the Windows suspension check that reports "left suspended" as a distinct named failure (FR-020, SC-002)
- [x] T020 Add an import restriction to `eslint.config.mjs` forbidding `tests/support/machine-probe.ts` from importing `apps/agent/src/platform/**` or `apps/agent/src/power/**`, and create `tests/machine-probe-independence.test.ts` doubling it by source scan
- [x] T020a [P] Extend `tests/power-spawn-coverage.test.ts` to cover every module this feature adds, so the ban on direct process spawning outside the governed seam still holds after the stub tools, the machine probe and the signing scripts land (FR-013)
- [x] T021 [P] Create `tests/support/stub-tools/` with governed, CPU-burning child processes that emit the encoder's progress dialect and support ignore-SIGTERM, hang and exit-code switches, promoted from the inline pattern in `tests/stop-leaves-nothing-running.test.ts`
- [x] T022 Create `tests/support/agent-process.ts` booting a real out-of-process local app, redirecting **all nine** state paths — including the four transcription paths the current harness omits (A13) — with a non-racy port allocation (A15) and no dead environment variables (A16)
- [x] T023 [P] Create `tests/support/fake-agent.ts` — one shared fake of the local app for interface tests, replacing the per-file hand-mocking (FR-021)
- [x] T024 [P] Fix the hardcoded absolute temp path in `tests/power-persistence.test.ts` so it cannot collide across runs and can work on Windows (B8)
- [x] T025 [P] Add a jsdom cleanup setup file to `vitest.config.ts` so the fourteen component test files that never clean up no longer leak between tests (B9)
- [x] T026 Add project and pool configuration to `vitest.config.ts` isolating the out-of-process end-to-end files to a single fork with an explicit timeout (B14)

### Lifecycle declaration

- [x] T027 Create `packages/shared/src/lifecycle.ts` with `TransitionTable`, `Lifecycle`, `defineLifecycle`, `canTransition`, `isTerminal`, `statesOf`, `edgesOf` per [contracts/lifecycle-api.md](./contracts/lifecycle-api.md)
- [x] T028 Add the seven lifecycle definitions and the `LIFECYCLES` registry to `packages/shared/src/lifecycle.ts` per [data-model.md §1.1](./data-model.md)
- [x] T029 Re-export the lifecycle module from `packages/shared/src/index.ts` and rebuild the committed `packages/shared/dist`
- [x] T030 [P] Create `tests/lifecycle-wellformed.test.ts` asserting reachability, no self-edges, valid targets, and a valid initial state for every registered lifecycle
- [x] T031 Create `tests/support/lifecycle-drivers.ts` with the driver-map type and an initially small driver set
- [x] T032 Create `tests/lifecycle-transitions.test.ts` asserting driver coverage in both directions, that each driver ends where the table says, and that every undeclared edge is refused without changing state (FR-019, SC-003)

### Tool module surface

- [x] T033 Extend the `ToolModule` interface in `apps/agent/src/server/tools.ts` with `lifecycle`, `cancel(id)` and `cancelAll()`, so FR-005 and FR-007 become structural
- [x] T034 Add a `transition(entity, next): boolean` helper to `apps/agent/src/queue/queue.ts` in **permissive** mode — records the edge, never blocks — per the rollout in [research.md §R3](./research.md)
- [x] T035 [P] Add the same permissive `transition()` to `apps/agent/src/queue/transcription-queue.ts`
- [x] T036 [P] Add the same permissive `transition()` to `apps/agent/src/landing/optimizer.ts`
- [x] T037 [P] Add the same permissive `transition()` to `apps/agent/src/landing-preview/catalog.ts`
- [x] T038 Run the full suite with permissive transitions recording, then reconcile every edge the running code actually takes against the tables in `packages/shared/src/lifecycle.ts` — a mismatch here is a table bug, not a code bug. **Done when** a full suite run records zero edges absent from the tables, asserted in `tests/lifecycle-transitions.test.ts` rather than read by hand

**Checkpoint**: Lifecycles are declared and enumerable, the machine can be observed independently of the app, and every test fixture the stories need exists once rather than per-file.

---

## Phase 3: User Story 1 — Interleaved work behaves predictably (Priority: P1) 🎯 MVP

**Goal**: What the screen says a job is doing is what the machine is doing — during a stop, after a stop, while another tool starts, after a restart, on both platforms.

**Independent Test**: Drive a real installation through a scripted ≥20-step interleaving sequence across ≥3 tools while observing the machine's actual process and consumption state, and assert agreement at every checkpoint. Passing this alone delivers the feature's core guarantee.

### Tests for User Story 1

- [x] T039 [P] [US1] Create `tests/compressor-activity.test.ts` characterising today's behaviour against the A11 gap list — `processing → interrupted` both in memory and at load, shutdown mid-encode, cancel-all ordering and batch closure, cancel during image preparation, the audio-copy fallback re-run with a cancel between passes, both recovery re-probe branches, and the estimate early return
- [x] T040 [P] [US1] Add compression drivers for all declared edges to `tests/support/lifecycle-drivers.ts`
- [x] T041 [P] [US1] Add transcription, translation, landing-job, landing-asset, landing-preview-item and media-action drivers to `tests/support/lifecycle-drivers.ts`
- [x] T042 [P] [US1] Create `tests/support/interleaving-scenarios.ts` with the typed step union and at least one scenario of ≥20 steps across ≥3 tools, asserted as a countable expression (SC-001)
- [x] T043 [US1] Create `tests/interleaving-e2e.test.ts` walking the scenarios against a real local app and calling `tests/support/machine-probe.ts` after every step, failing immediately with the step index on disagreement
- [x] T044 [P] [US1] Add a scenario generator to `tests/support/interleaving-scenarios.ts` that derives steps from the transition tables, so FR-019 and FR-020 reinforce each other
- [x] T045 [P] [US1] Create `tests/stop-releases-machine.test.ts` asserting the 5-second process-gone and 10-second consumption-at-idle windows via the machine probe rather than the exit signal (SC-002, A14, FR-002)
- [x] T045a [P] [US1] Create `tests/stop-releases-slot.test.ts` asserting a new run starts while the stopped one is still unwinding — the queue slot is freed before teardown completes, not after (FR-004)
- [ ] T045b [P] [US1] Add a case to `tests/real-media-e2e.test.ts` asserting that a run stopped mid-encode and then re-run produces output equivalent to one never stopped, by decoded content, duration and dimensions (FR-008)
- [x] T046 [P] [US1] Create `tests/agent-restart-recovery.test.ts` covering forced termination, sleep/wake, and the interrupted-not-running presentation on next start (FR-006, FR-009a, SC-022)
- [x] T047 [P] [US1] Create `tests/start-serialisation.test.ts` asserting 100 simultaneous double-starts produce exactly one run (FR-009c, SC-021)
- [x] T048 [P] [US1] Create `tests/stream-multiplex.test.ts` asserting one connection carries every channel, that snapshots replay per channel, and that a start or stop completes within 1 second with every channel subscribed (FR-009b, SC-020)

### Implementation — transitions and lifecycle

- [x] T049 [US1] Flip `transition()` to strict in `apps/agent/src/queue/queue.ts`, leaving state unchanged and returning false on refusal (FR-001)
- [x] T050 [P] [US1] Flip `transition()` to strict in `apps/agent/src/queue/transcription-queue.ts`
- [x] T051 [P] [US1] Flip `transition()` to strict in `apps/agent/src/landing/optimizer.ts`
- [x] T052 [P] [US1] Flip `transition()` to strict in `apps/agent/src/landing-preview/catalog.ts`
- [x] T053 [US1] Map a refused transition to `409 TRANSITION_NOT_ALLOWED` in `apps/agent/src/compressor/routes.ts`, `apps/agent/src/transcription/routes.ts`, `apps/agent/src/landing/routes.ts` and `apps/agent/src/landing-preview/routes.ts`
- [x] T054 [US1] Add `interrupted` to `TranscriptionJobStatus` in `packages/shared/src/types.ts` and map a restarted in-flight run to it in `apps/agent/src/queue/transcription-store.ts`, leaving existing persisted records untouched (A12, FR-006)
- [x] T055 [US1] Make `LandingJobPhase` derived via `phaseOf(status, step)` in `apps/agent/src/landing/optimizer.ts`, keeping the wire field and removing nine independently assignable states (data-model §1.2)
- [x] T056 [P] [US1] Replace the ~30 hand-written status-array literals across `apps/agent/src` and `apps/web/src` with `isTerminal` and `canTransition` from the shared module

### Implementation — compressor activity collapse

- [x] T057 [US1] Add a derived `get activity(): CompressorActivity` to `apps/agent/src/queue/queue.ts` alongside the existing five fields, and rewrite `running()`, `compressionActive()` and the four guards to read it
- [x] T058 [US1] Add a test-only invariant assertion in `tests/compressor-activity.test.ts` that the shadow value and the five fields agree at every broadcast
- [x] T059 [US1] Invert the representation in `apps/agent/src/queue/queue.ts` — store `activity`, make the five fields getters — deleting write sites in the order `compressionInFlight → activeAbort → active → (prioritizingEstimates + compressionPausedForEstimates together)`
- [x] T060 [US1] Delete the five getters from `apps/agent/src/queue/queue.ts` and fold the hold release into the `encoding-held` variant, closing A5
- [x] T061 [US1] Use `activity.jobId` in the shutdown path of `apps/agent/src/queue/queue.ts` to unlink the partial output, closing A2(i) (FR-003)
- [x] T062 [P] [US1] Unlink orphaned partial output at load in `apps/agent/src/queue/store.ts` where the code already concludes the run died mid-flight, closing A2(ii) (FR-003a)
- [x] T063 [P] [US1] Fix the restored-batch `finishedAt` default in `apps/agent/src/queue/store.ts` so the drain watchdog can fire, closing A8, and add its test to `tests/queue.test.ts`

### Implementation — stop everywhere

- [x] T064 [P] [US1] Add per-job cancel to `apps/agent/src/queue/transcription-queue.ts` and expose it in `apps/agent/src/transcription/routes.ts` (FR-005)
- [x] T065 [P] [US1] Add per-job cancel to `apps/agent/src/landing/optimizer.ts` and expose it in `apps/agent/src/landing/routes.ts`
- [x] T066 [US1] Add `cancelled` to `MediaActionStatus` and move the union into `packages/shared/src/types.ts` (data-model §1.4)
- [x] T067 [US1] Promote the abandon path in `apps/agent/src/media-actions/queue.ts` into `cancel(id)` and `cancelAll()`, with a scaled per-job deadline so a wedged conversion cannot hold the machine with no window open (A3)
- [x] T068 [US1] Add session-authenticated `POST /api/media-actions/:id/cancel` and `POST /api/media-actions/cancel-all` to `apps/agent/src/media-actions/routes.ts`
- [x] T069 [US1] Add optional media-action state to `QueueState` in `packages/shared/src/types.ts` so it rides the compressor's existing stream rather than opening an eighth channel (FR-009b)
- [x] T070 [US1] Mark abandoned media-action jobs cancelled and unlink their partial outputs on shutdown in `apps/agent/src/media-actions/queue.ts`, and label the list session-scoped in `apps/web/src/` — deliberately **not** adding persistence, which would be new capability
- [x] T071 [P] [US1] Add a media-action surface to the interface so a Finder-initiated conversion is visible and stoppable, in `apps/web/src/` alongside the compressor view

### Implementation — connection budget

- [x] T071a [P] [US1] Audit `apps/web/src/` for any affordance implying a stopped run can be resumed rather than re-run, and remove or relabel it — no resume exists anywhere in the local app, so offering one is the interface lying (FR-008)
- [x] T072 [US1] Convert `EventChannel` in `apps/agent/src/server/sse.ts` into a named-channel hub with per-channel snapshot replay
- [x] T073 [US1] Create `apps/agent/src/server/stream.ts` implementing `GET /api/stream?channels=…` with header authentication, the frame envelope, and its own cross-origin headers on the hijacked response, per [contracts/agent-http.md §2](./contracts/agent-http.md)
- [x] T074 [US1] Register the channels through the hub in `apps/agent/src/index.ts` and `apps/agent/src/power/routes.ts`, keeping the seven existing endpoints in place for older clients
- [x] T075 [US1] Add the `event-stream` capability flag to `packages/shared/src/types.ts` and the health payload in `apps/agent/src/server/app.ts`
- [x] T076 [US1] Create `apps/web/src/api/event-stream.ts` — a fetch-based reader with a manual frame parser that sends the token as a request header
- [x] T077 [US1] Rewrite `apps/web/src/api/useAgentEventStream.ts` to subscribe to multiplexed channels through the new reader, with a capability-gated fallback to the seven existing URLs
- [x] T078 [US1] Collapse the seven stream URL builders in `apps/web/src/api/client.ts` into one, and migrate the three direct stream consumers in `apps/web/src/landing/LandingOptimizerPage.tsx`, `apps/web/src/transcription/TranscriptionPage.tsx` and `apps/web/src/landing-viewer/sources/agentLandingSource.ts` onto the hook
- [x] T079 [US1] Serialise start requests in `apps/agent/src/queue/queue.ts` so two simultaneous requests produce exactly one run (FR-009c)
- [ ] T080 [US1] Handle sleep and wake in `apps/agent/src/power/governor.ts` and `apps/agent/src/queue/queue.ts` so in-flight work either continues correctly or is presented as interrupted (FR-009a)

**Checkpoint**: User Story 1 is fully functional and independently testable. Every state transition is declared and enforced, every tool can be stopped, a stop leaves nothing running, and the interface holds one connection instead of seven.

---

## Phase 4: User Story 2 — Power is one shared budget that never lies (Priority: P1)

**Goal**: Whatever combination of tools is running, together they stay within one limit — and if the platform cannot enforce it, the interface says so instead of showing a lever that does nothing.

**Independent Test**: Run every combination of concurrently-runnable tools at several limits on both platforms, sample consumption independently of the app, then force the enforcement mechanism to fail and confirm the interface reports the limit as unenforceable. **Independent except T093**, which needs the multiplexed stream from User Story 1; everything else here stands alone.

### Tests for User Story 2

- [x] T081 [P] [US2] Create `tests/power-shared-budget.test.ts` asserting the 60-second average and 10-second worst-stretch bounds across tool combinations via the machine probe (SC-004, FR-010)
- [x] T082 [P] [US2] Add cases to `tests/power-windows-suspend.test.ts` asserting that once the suspend helper gives up, the reported support flag turns false and reaches the interface (A1, FR-011)
- [x] T083 [P] [US2] Add a case to `tests/power-governor.test.ts` asserting the termination pin ages out on wall clock even when the duty cycler is stopped (A6)
- [x] T084 [P] [US2] Create `tests/landing-preview-concurrency.test.ts` asserting the render slot count falls when the limit is lowered, including for work already running (A7, FR-012a)
- [x] T085 [P] [US2] Add a case to `tests/power-sampler.test.ts` asserting the reported share reaches the idle threshold within 10 seconds of the last work ending (FR-012)
- [x] T086 [P] [US2] Add a case to `tests/real-media-e2e.test.ts` asserting output equivalence between a throttled and an unthrottled run by decoded content, duration and dimensions — explicitly not by bytes

### Implementation for User Story 2

- [x] T087 [US2] Pass an error listener when constructing the suspend helper in `apps/agent/src/platform/platform.ts` and export a subscription for its permanent-failure signal
- [x] T088 [US2] Make `processPauseSupported()` in `apps/agent/src/platform/platform.ts` a live read of the helper's disabled state rather than a static per-platform constant
- [x] T089 [US2] Make the support flag in `apps/agent/src/power/governor.ts` mutable, driven by that subscription, and broadcast the change through the existing state channel so the already-built unsupported interface state becomes reachable (A1)
- [x] T090 [US2] Age the termination pin on wall clock in `apps/agent/src/power/governor.ts`, evaluating it in the retune and set-limit paths as well, so it survives a stopped cycler (A6)
- [x] T091 [US2] Derive the render slot count from the live thread budget in `apps/agent/src/landing-preview/catalog.ts` and re-evaluate it on the governor's change event (A7, FR-012a)
- [x] T092 [P] [US2] Show a pending-not-applied affordance on the lever in `apps/web/src/lib/power.tsx` when a limit change could not reach the local app, instead of displaying a limit that is not in force (D9)
- [x] T093 [P] [US2] Subscribe the consumption channel only while the power panel is watching in `apps/web/src/lib/power.tsx`, now that channels are multiplexed, so sampling does not run permanently

**Checkpoint**: The lever is one shared budget, it affects running work, it reduces parallelism where a user would expect it to, and it tells the truth when it cannot be enforced.

---

## Phase 5: User Story 3 — The whole application verifies itself in one command (Priority: P1)

**Goal**: One command, one machine-readable verdict, almost no output on success — and automation that blocks a merge on both platforms.

**Independent Test**: Run the single command on a clean checkout; then deliberately break one thing in each covered category and confirm each is caught and named.

### Tests for User Story 3

- [x] T094 [P] [US3] Create `tests/verify-all.test.ts` asserting each gate id appears in exactly one form's list, that a stubbed failing gate surfaces its own id in `error`, and that the 20-line and 100-line output budgets hold with the subject in the first 10 lines
- [x] T095 [P] [US3] Create `tests/run-state-coverage.test.ts` walking the import graph from the run-state entry points and asserting every module reached appears in the critical-modules file (FR-018a)
- [x] T096 [P] [US3] Create `tests/workflow-contract.test.ts` asserting every workflow reads the Node version from the version file, pins no literal version, and names no test path that does not exist on disk (B11)

### Implementation — the aggregator

- [x] T097 [US3] Create `scripts/lib/gate.mjs` with the gate runner, bounded output ring buffer, per-gate timeout, and the per-gate excerpt extractors from [contracts/verification-cli.md](./contracts/verification-cli.md)
- [x] T098 [US3] Create `scripts/verify-all.mjs` implementing the four phases with parallelism inside a phase and a strict barrier between phases, with the suite phase exclusive (A17, FR-014)
- [x] T099 [US3] Implement the result envelope in `scripts/verify-all.mjs` — the existing analytics shape extended with `form`, without `period` — and write it to `verification-result.json` (FR-015)
- [x] T100 [US3] Implement the 20-line success and 100-line failure output budgets in `scripts/verify-all.mjs`, asserting the caps rather than hoping for them (SC-005)
- [x] T101 [US3] Invoke the suite from `scripts/verify-all.mjs` with passed-only silencing plus the dot and JSON reporters, capturing structure from the JSON report (B6)
- [x] T102 [US3] Read skip counts and requirement markers from the JSON report in `scripts/verify-all.mjs`, histogram them, and fail the run on any skipped test whose name carries no marker (SC-007)
- [x] T103 [US3] Add `verify` and `verify:release` scripts to `package.json` and add `verification-result.json` to `.gitignore` (FR-014a)
- [x] T104 [P] [US3] Replace the ten hand-typed release commands in `docs/PRODUCTION.md` and `docs/BETA.md` with the single command

### Implementation — coverage

- [x] T105 [US3] Add the V8 coverage provider to `package.json` devDependencies and configure it in `vitest.config.ts` with `all: true` and the include/exclude sets from [research.md §R16](./research.md)
- [x] T106 [US3] Record the first measurement as `coverage-baseline.json` at the repository root
- [x] T107 [US3] Create `coverage-critical.json` at the repository root seeding the run-state modules with absolute floors
- [x] T108 [US3] Enforce critical floors first and the ratchet second in `scripts/verify-all.mjs`, so a falling global can never excuse an uncovered state module (FR-018)
- [x] T109 [US3] Add `--update-coverage-baseline` to `scripts/verify-all.mjs`

### Implementation — the end-to-end harness

- [x] T110 [US3] Create `tests/real-media-e2e.test.ts` carrying the contract, compatibility-matrix and encode-fidelity assertions moved verbatim out of `scripts/real-agent-check.mjs`
- [x] T111 [US3] Shrink `scripts/real-agent-check.mjs` to a shim that runs the two end-to-end test files with the release profile, so exactly one boot path exists (B10)
- [x] T112 [US3] Add the `lifecycle` and `real-media` profile switches to `tests/support/agent-process.ts`, selecting stub or real tools
- [x] T113 [US3] Skip the transcription fidelity cases with a named absent-model reason in `tests/real-media-e2e.test.ts` rather than downloading a multi-gigabyte model in automation

### Implementation — automation

- [x] T114 [US3] Create `.github/workflows/verify.yml` with pull-request and default-branch triggers, cancel-in-progress, and the five jobs from [contracts/verification-cli.md](./contracts/verification-cli.md, FR-017)
- [x] T115 [US3] Run the end-to-end job in `.github/workflows/verify.yml` only on default-branch pushes and labelled pull requests, with per-job timeouts and dependency caching
- [x] T116 [US3] Delete the hand-maintained fifteen-file test list from `.github/workflows/release-windows.yml` and run the whole suite there, relying on named skips (B11)
- [x] T117 [US3] Reduce the validate job in `.github/workflows/release-windows.yml` to depend on the shared workflow instead of duplicating formatting, lint and the suite
- [x] T118 [US3] Reduce `.github/workflows/release-test.yml` to a dispatch wrapper over the release form
- [x] T118a [US3] Configure branch protection so `static`, `test-macos`, `test-windows` and `build` from `.github/workflows/verify.yml` are required checks on the default branch, and record the setting in `docs/PRODUCTION.md`, since it lives in repository settings rather than in a file (SC-006)
- [ ] T119 [US3] Run the full suite on a Windows runner once and record every failure as categorised entries in `specs/009-release-hardening-pass/findings.md` — discovery only, no fixes
- [ ] T119a [US3] Fix the path-separator and temp-directory failures from T119's list, across the affected files in `tests/`
- [ ] T119b [US3] Fix the process-spawn and platform-tool failures from T119's list, across the affected files in `tests/` and `apps/agent/src/platform/`
- [x] T120 [US3] Parse the dependency audit inside `scripts/verify-all.mjs`, blocking on production high or critical, counting development-only findings as informational, and failing on an **expired** exception — landing report-only and flipping to blocking in the same change, since T012 has already cleared the tree (FR-030)

**Checkpoint**: One command verifies everything, reports machine-readably, and blocks merges on both platforms. Every later story is now cheap to keep true.

---

## Phase 6: User Story 4 — The interface tells the truth when things go wrong (Priority: P2)

**Goal**: A brief interruption looks like a brief interruption, not an uninstalled application.

**Independent Test**: Interrupt the connection at each point in a run, on each tool page, with one and with three tabs, and assert what the user sees at each moment.

**⚠️ Gated on T001** — the loudest findings in this story were never observed in a browser.

### Tests for User Story 4

- [x] T121 [P] [US4] Create `tests/agent-disconnect-ui.test.tsx` asserting that a 2-second interruption produces no visible disconnect, that a 10-second one keeps the page mounted with input intact, and that no installation prompt appears to a previously connected user (FR-033, SC-012)
- [x] T122 [P] [US4] Create `tests/state-revision-guard.test.ts` asserting a stale response cannot overwrite a newer snapshot, and that a fresh connect after a restart correctly resets rather than being rejected as stale (FR-037, D3, SC-013)
- [x] T123 [P] [US4] Create `tests/repair-handshake.test.ts` asserting a wrong origin is refused, a wrong nonce is refused, the timeout falls back to navigation, and two tabs produce exactly one handshake (D4)
- [x] T124 [P] [US4] Add cases to `tests/shell-and-modal-layout.test.ts` asserting no reachable state renders a dialog without a dismissal (FR-033)
- [x] T125 [P] [US4] Create `tests/frozen-progress.test.tsx` asserting the progress animation and elapsed timer stop while disconnected (FR-036, D6)

### Implementation for User Story 4

- [x] T126 [US4] Add a 3-second grace period and progressive backoff to `apps/web/src/api/useAgentEventStream.ts` so a short interruption never reaches the interface (FR-034)
- [x] T127 [US4] Stop treating a live message as proof of health in `apps/web/src/AgentContext.tsx`; derive connection state from the whole connection, not the stream alone (FR-035, D5)
- [x] T128 [US4] Gate the setup screen in `apps/web/src/ProtectedSoty.tsx` on connected-but-unsupported rather than on transport, so tool pages stay mounted through an interruption (D1, FR-039)
- [x] T129 [US4] Pass a close handler to the local-app dialog in `apps/web/src/ProtectedSoty.tsx` so it can never be un-closable (D1)
- [x] T130 [US4] Revive the in-page degradation at `apps/web/src/App.tsx` and give the disconnected state its own branch instead of letting it fall through to the generic onboarding panel (D2)
- [x] T131 [P] [US4] Distinguish never-connected from was-connected in `apps/web/src/HomePage.tsx` so a blip does not show download instructions (D2)
- [x] T132 [P] [US4] Pass connection state into `apps/web/src/components/JobRow.tsx` so the flowing animation and the elapsed interval both stop while disconnected (D6)
- [x] T133 [US4] Add a monotonic `revision` to `QueueState`, `TranscriptionState` and `LandingState` in `packages/shared/src/types.ts` with the comparison helper (data-model §3)
- [x] T134 [US4] Increment the revision by wrapping the injected notify callback once in each of `apps/agent/src/queue/queue.ts`, `apps/agent/src/queue/transcription-queue.ts` and `apps/agent/src/landing/optimizer.ts` — not at the thirty-plus call sites
- [x] T135 [US4] Apply the newer-wins guard in one place in `apps/web/src/AgentContext.tsx`, with a documented bypass for a fresh connect keyed on the reported instance identity
- [x] T136 [P] [US4] Apply the same guard to the local state writers in `apps/web/src/transcription/TranscriptionPage.tsx` and `apps/web/src/landing/LandingOptimizerPage.tsx`
- [x] T137 [US4] Add a handshake route to `apps/agent/src/server/app.ts` serving a minimal document that posts the token to a server-chosen target origin, never a wildcard and never the requesting origin
- [x] T138 [US4] Implement the in-page handshake in `apps/web/src/api/pairing-token.ts` with nonce, origin and source verification, and a timeout fallback to the existing navigation
- [x] T139 [US4] Move the automatic pairing budget from per-tab to per-browser storage in `apps/web/src/api/pairing-token.ts` and add a claim election over the existing broadcast channel, so three tabs perform one handshake (D4)
- [x] T140 [US4] Replace the navigation call in `apps/web/src/AgentContext.tsx` with the in-page re-pair so unsaved work survives (FR-038)
- [x] T141 [P] [US4] Replace the hardcoded placeholder progress in `apps/web/src/team/library/ProcessLibraryDialog.tsx` with a real measurement (D7, FR-040)
- [x] T142 [P] [US4] Add an in-flight disabled state and accurate post-action counts to the stop paths in `apps/web/src/App.tsx` and `apps/web/src/components/JobRow.tsx` (D8, FR-041)
- [x] T143 [P] [US4] Clear the toast timers on unmount in `apps/web/src/App.tsx`, `apps/web/src/transcription/TranscriptionPage.tsx` and `apps/web/src/landing/LandingOptimizerPage.tsx` (D12)

**Checkpoint**: Every tool page behaves identically under interruption, the interface never moves backwards, and re-pairing no longer destroys the page.

---

## Phase 7: User Story 5 — Hardened against attack and against leaking (Priority: P2)

**Goal**: A hostile page, a hostile local process, or a compromised dependency cannot use the local app; nothing leaves the machine carrying user file data; nothing is trusted without proof of origin.

**Independent Test**: An adversarial suite of ≥30 attempts against a real running local app, all refused, plus a positive suite proving legitimate flows still work, plus a leak inspection of everything transmitted.

**Note**: the four wave-zero implementation items that used to live in this phase are now **T014a–T014d in Phase 1** — two of the holes they close are confirmed live by probing, and burying them behind six phases was the wrong order. Their tests (T144, T147) stay here and are written against those implementations.

### Tests for User Story 5

- [x] T144 [P] [US5] Create `tests/agent-admission.test.ts` covering spoofed hosts, missing hosts, duplicate hosts, hostile origins, missing origins, the pairing navigation discriminator, the native fetch-metadata discriminator, and a repeated token query parameter yielding an array (C4, C5, C6)
- [x] T144a [P] [US5] Create `tests/hostile-filenames.test.ts` driving a fixed adversarial name set — quotation marks, backslashes, shell-significant characters, newlines, non-ASCII — through upload, drop resolution and the picker, asserting no part of a name is ever interpreted as an instruction (SC-023, C14)
- [x] T145 [P] [US5] Create `tests/path-grants.test.ts` with the adversarial set — traversal, symlink swapped between grant and use, credential-store paths, network paths, extended-length prefixes, short names, case collisions — **and** the positive set: pick → restart → resume, drop → restart → resume, output folder still writable (C3)
- [ ] T146 [P] [US5] Create `tests/upload-budgets.test.ts` asserting per-route file limits, the folder-session file/byte/time budgets, path depth bounds, and that the multipart default is now restrictive (C8)
- [x] T147 [P] [US5] Create `tests/log-redaction.test.ts` asserting no log line contains a token, a query string, a path-shaped identifier, or a redirect location (C10, FR-029)
- [ ] T147a [P] [US5] Create `tests/transmitted-payload-leak.test.ts` sweeping everything that leaves the machine or is shown as a failure — the analytics property allowlist, the diagnostics response, error payloads and crash reports — asserting zero file names, paths or user content, while explicitly permitting the interface to show the user the names of files they themselves added (SC-009, FR-029)
- [ ] T148 [P] [US5] Create `tests/mac-signing-chain.test.ts` verifying the signing, hardened-runtime and stapling chain against a self-signed identity in a throwaway keychain (C1, SC-010)
- [ ] T149 [P] [US5] Create `tests/release-manifest-pinning.test.ts` asserting an artifact on an unexpected host or with a malformed hash is rejected (C11)
- [x] T150 [P] [US5] Create `tests/pairing-verify-before-adopt.test.ts` asserting a planted token is discarded without ever reaching persistent storage (C12)
- [ ] T151 [P] [US5] Create `tests/csp-smoke.test.ts` driving a browser through pair → compress → open a preview → sign in and asserting zero policy violations (C2)
- [ ] T152 [P] [US5] Create `tests/transfer-grant-tickets.test.ts` asserting forged, replayed, expired and wrong-team tickets are all refused on the unauthenticated backend range paths (C9)
- [ ] T152a [US5] Create `tests/adversarial-suite-size.test.ts` collecting the attempt count across `tests/agent-admission.test.ts`, `tests/path-grants.test.ts`, `tests/upload-budgets.test.ts`, `tests/hostile-filenames.test.ts` and `tests/transfer-grant-tickets.test.ts`, asserting at least 30 attempts at a 100% refusal rate — a countable assertion, not a claim in prose (SC-008)

### Implementation — signing and update integrity

- [ ] T157 [US5] Create `scripts/sign-mac-app.sh` implementing inside-out signing, hardened runtime, notarization and stapling, with entitlements derived from what the app actually does (FR-028)
- [ ] T158 [US5] Replace the ad-hoc signing in `scripts/package-mac.sh` with a call to the new chain, falling back to a self-signed identity when credentials are absent
- [ ] T159 [P] [US5] Add signing of the tray host before installer compilation and of the installer after, with timestamping and retries, to `.github/workflows/release-windows.yml` and `packaging/windows-installer.iss`
- [ ] T160 [P] [US5] Assert the signature in `scripts/verify-windows-package.mjs` and `scripts/windows-smoke.mjs`
- [ ] T161 [US5] Export the allowed artifact origin as a single constant in `packages/shared/src/release.ts` and enforce host and hash shape in `apps/web/src/release-manifest.ts` (C11, FR-028)
- [ ] T162 [US5] Re-hash the published artifact in `scripts/verify-release.mjs`

### Implementation — the browser origin

- [ ] T163 [US5] Rewrite the boot-recovery block in `apps/web/index.html` to remove its inline handler and inline styles, and localise its text and theme (C2, FR-057)
- [ ] T164 [US5] Add a build step generating policy hashes for the two inline blocks and writing them into `apps/web/public/_headers`
- [ ] T165 [US5] Write the full header set into `apps/web/public/_headers` per [contracts/web-origin-headers.md](./contracts/web-origin-headers.md), with the connect list covering the local app across ports (FR-025)

### Implementation — tokens out of URLs

- [x] T166 [US5] Create `apps/agent/src/server/tickets.ts` issuing path- and method-bound capability tickets with a five-minute lifetime, derived from but not equal to the session token
- [x] T167 [US5] Issue tickets in the authenticated responses describing image, preview and media resources in `apps/agent/src/compressor/routes.ts`, `apps/agent/src/landing-preview/routes.ts` and `apps/agent/src/transcription/routes.ts`
- [x] T168 [US5] Remove the token query parameter from the remaining subresource URL builders in `apps/web/src/api/client.ts`, using tickets instead — range requests must keep working

### Implementation — the path ledger and its prerequisites

- [x] T169 [P] [US5] Validate the support-directory environment override as a single path segment in `apps/agent/src/files/support-dir.ts`, and refuse the state-path overrides in a packaged production build (C19)
- [x] T170 [P] [US5] Remove the model hash from the environment-overridable set in `apps/agent/src/translation/tools.ts`, so the pin cannot be changed by whoever changed the source (C19, FR-032e)
- [x] T171 [P] [US5] Write state files with owner-only permissions under an owner-only parent in `apps/agent/src/queue/store.ts`, `apps/agent/src/queue/transcription-store.ts`, `apps/agent/src/entitlement/entitlement.ts` and the preview catalog, and tighten the beta environment file in `scripts/beta-up.mjs` (C18, FR-032d)
- [x] T172 [US5] Create `apps/agent/src/files/path-grants.ts` implementing the ledger from [data-model.md §4](./data-model.md), including pattern-bound derived-output write scope, device and inode re-checking, and the outer bound (FR-026)
- [X] T173 [US5] Mint grants inside every selector in `apps/agent/src/files/picker.ts` and on successful resolution in `apps/agent/src/files/dropped-source.ts`, so no caller can forget
- [ ] T174 [US5] Mint grants in the native bridge handlers in `apps/agent/src/media-actions/routes.ts`, then run the same check as everyone else — no bypass
- [X] T175 [US5] Rebuild the ledger on boot from the durable tool state in `apps/agent/src/index.ts`, resolving and stat-ing each path, so restoration and authorisation cannot disagree
- [X] T176 [US5] Consult the ledger in `apps/agent/src/compressor/routes.ts`, `apps/agent/src/transcription/routes.ts` and `apps/agent/src/landing-preview/routes.ts`, in **observe mode** — evaluate, count, allow — refusing with one code for every cause and matching in memory before touching the filesystem, and emit the would-refuse count through the diagnostics surface so the rate is measurable rather than anecdotal
- [ ] T177 [US5] Accept grant identifiers in place of absolute paths in those three routes and in `apps/web/src/api/client.ts`, keeping raw-path acceptance only where it resolves to an existing grant
- [ ] T178 [US5] Flip the ledger from observe to enforce in `apps/agent/src/files/path-grants.ts`, with no environment flag to disable it. **Exit criterion, fixed before T176 ships**: at least 200 observed path uses across at least 10 distinct beta sessions covering pick, drop, Finder and restore, with **zero** would-refuse events not already reproduced by a positive-suite case. One unexplained would-refuse resets the count
- [x] T179 [P] [US5] Route the six reveal and open call sites through one guarded helper in `apps/agent/src/platform/platform.ts` that resolves, stats, and rejects executable or URL-shaped targets (C15, FR-032b)
- [x] T180 [P] [US5] Remove the import temp directory on the success path in `apps/agent/src/transcription/routes.ts` and add a boot sweep plus a periodic unreferenced-directory sweep in `apps/agent/src/files/support-dir.ts` (C16, FR-032c)

### Implementation — the remainder

- [x] T181 [P] [US5] Add per-route rate budgets and the auth-failure cooldown to `apps/agent/src/server/app.ts`, with a constant key and a comment stating why a per-address limiter would be theatre (C7)
- [ ] T182 [P] [US5] Add the folder-upload session budget, echoed session identifier, path depth bounds and exclusive-create write to `apps/agent/src/landing/routes.ts` (C8)
- [x] T183 [P] [US5] Add the subscriber cap, oldest-first eviction with a terminal frame, heartbeat and stalled-writer drop to `apps/agent/src/server/sse.ts` (C7)
- [x] T184 [P] [US5] Replace string interpolation with argument passing in the system search in `apps/agent/src/files/dropped-source.ts`, and make the picker script safe by construction rather than by accident in `apps/agent/src/files/picker.ts` (C14, FR-032a)
- [ ] T185 [P] [US5] Map failures to a fixed code list in `apps/agent/src/server/app.ts`, `apps/agent/src/landing/routes.ts` and `apps/agent/src/landing-preview/routes.ts`, and add a guard test so relaying an underlying message cannot regress (C17, FR-029a)
- [x] T186 [P] [US5] Verify a candidate pairing token against the local app before persisting or broadcasting it in `apps/web/src/api/pairing-token.ts` (C12, FR-032)
- [ ] T187 [P] [US5] Sign, bind, time-limit and single-use the transfer grants in `supabase/functions/drive-transfer/index.ts` and `supabase/functions/_shared/operations.ts`, with replay detection by unique insert (C9, FR-031)
- [ ] T188 [P] [US5] Build the backend origin allowlist from deployment configuration in `supabase/functions/_shared/cors.ts` and add a deploy check asserting production contains no loopback origin (C20, FR-032f)
- [x] T189 [P] [US5] Unreference the release-path polling timer in `apps/agent/src/index.ts` (C21)

**Checkpoint**: The adversarial suite passes, nothing leaks, and both platforms verify their publisher — pending only the credential substitution.

---

## Phase 8: User Story 6 — Faster to load and smoother to use (Priority: P3)

**Goal**: Opens quickly, scrolls smoothly at scale, respects a reduced-motion preference.

**Independent Test**: Measure download size, time to interactive on a throttled profile, and interaction responsiveness with a large queue and a long transcript, against baselines recorded before any change. **Not independent of User Story 4**: reconciliation lives inside the state writer T135 creates, so T192–T197 cannot precede it. The bundle and image tasks T199–T207 are independent.

### Tests for User Story 6

- [ ] T190 [P] [US6] Create `tests/performance-budgets.test.ts` recording the pre-change baseline and asserting the bundle, load-time and interaction budgets, including that each of the three largest pieces falls (FR-048, SC-014)
- [ ] T191 [P] [US6] Create `tests/render-counts.test.tsx` asserting that a live update does not rebuild rows whose data did not change (FR-042, SC-015)

### Implementation for User Story 6

- [ ] T192 [US6] Split `apps/web/src/AgentContext.tsx` into a low-frequency status context and an external store with selectors, keeping the existing hook as a shim and the test override working
- [ ] T193 [US6] Create `apps/web/src/api/reconcile-queue.ts` returning previous references for unchanged jobs and the previous array when nothing changed, so memoisation is not a no-op
- [ ] T194 [US6] Apply reconciliation inside the state writer in `apps/web/src/AgentContext.tsx`
- [ ] T195 [US6] Stabilise the four inline callbacks and move the selection arithmetic behind refs in `apps/web/src/App.tsx`, then memoise `apps/web/src/components/JobRow.tsx`
- [ ] T196 [P] [US6] Memoise the remaining derived selections in `apps/web/src/App.tsx` and delete the per-render identifier join key
- [ ] T197 [P] [US6] Memoise the context value in `apps/web/src/AuthContext.tsx`
- [ ] T198 [US6] Bound the broadcast rate and send only what changed in `apps/agent/src/queue/queue.ts` and `apps/agent/src/server/sse.ts` (FR-043, E4)
- [ ] T199 [US6] Lazy-load the tool pages, the workspace and the admin screen in `apps/web/src/lib/tool-registry.ts` and `apps/web/src/ProtectedSoty.tsx` (FR-045)
- [ ] T200 [P] [US6] Lazy-load the code generator in `apps/web/src/components/SupportDialog.tsx` so it does not ship to everyone
- [ ] T201 [US6] Move the decorative field's data out of the entry bundle and mount it per route rather than above the router in `apps/web/src/Root.tsx` and `apps/web/src/components/HoneycombField.tsx`
- [ ] T202 [US6] Remove the per-element filter from the pointer-driven loop in `apps/web/src/components/HoneycombField.tsx` and gate the whole effect on a reduced-motion preference and a constrained-machine check (FR-047)
- [ ] T203 [US6] Add chunking configuration to `apps/web/vite.config.ts` so the vendor and workspace code split apart
- [ ] T204 [US6] Virtualise the compressor queue in `apps/web/src/App.tsx` (FR-044)
- [ ] T205 [US6] Virtualise the transcript segment lists in `apps/web/src/transcription/TranscriptTextModal.tsx` and remove the half-second recomputation interval
- [ ] T206 [P] [US6] Add lazy loading, explicit dimensions and async decoding to the ten image sites listed under E8 across `apps/web/src/` (FR-046)
- [ ] T207 [P] [US6] Add a minimum interval to the manifest polling in `apps/web/src/AgentContext.tsx` and throttle the tooltip measurement in `apps/web/src/components/ui.tsx` (E9)

**Checkpoint**: Measurably smaller, measurably faster, and enforced against regression.

---

## Phase 9: User Story 7 — One consistent surface (Priority: P3)

**Goal**: Every dialog behaves the same, every colour comes from the theme, every count reads correctly in both languages, and nothing on screen is a leftover.

**Independent Test**: Automated checks over the stylesheet, the interface source and the translations, plus an accessibility pass on every route in both themes and both languages.

### Tests for User Story 7

- [ ] T208 [P] [US7] Create `tests/design-token-contract.test.ts` asserting the checker catches an undefined property, an off-scale value and a duplicate rule block
- [ ] T209 [P] [US7] Create `tests/route-matrix-contract.test.ts` asserting every literal path compared in `apps/web/src/Root.tsx` and `apps/web/src/ProtectedSoty.tsx` is a member of the exported route list, so a new route cannot escape the sweep
- [ ] T210 [P] [US7] Create `tests/i18n-plurals.test.ts` asserting each count string is correct in both languages across the plural categories

### Implementation — the checkers

- [ ] T211 [US7] Create `scripts/verify-styles.mjs` parsing `apps/web/src/styles.css`, cross-referencing component inline styles to resolve legitimately-external properties, and checking undefined properties, off-scale values, the stacking scale and duplicate blocks (SC-017)
- [ ] T212 [US7] Extract the browser and accessibility core of `apps/soty-review/scripts/verify-review.mjs` into `scripts/lib/axe-sweep.mjs` and hoist its two dependencies to the root `package.json`
- [ ] T213 [US7] Create `scripts/verify-a11y.mjs` serving the built interface and walking the route matrix in both themes and both languages, using `tests/support/fake-agent.ts` to reach authenticated routes (FR-053)
- [ ] T214 [US7] Land the accessibility sweep in report-only mode with a committed violation baseline, wired into `scripts/verify-all.mjs`
- [ ] T215 [US7] Create `scripts/verify-i18n.mjs` scanning every string literal rather than every call site, subtracting a committed dynamic-key allowlist (SC-018)
- [ ] T216 [US7] Create `i18n-dynamic.json` at the repository root and add a lint rule to `eslint.config.mjs` forbidding the translation-key cast outside registered files

### Implementation — the fixes

- [ ] T217 [US7] Define the nine referenced-but-undefined custom properties in `apps/web/src/styles.css`, or delete the three orphan blocks that use them (F1, FR-049)
- [ ] T218 [US7] Create the text-size scale in `apps/web/src/styles.css` and replace the fractional pixel literals, so browser font-size settings are honoured (F2, FR-050)
- [ ] T219 [US7] Create the stacking scale in `apps/web/src/styles.css` and move all 58 raw values onto it, excluding view-transition pseudo-elements (F3, FR-050)
- [ ] T220 [US7] Move the off-grid spacing declarations onto the spacing scale in `apps/web/src/styles.css` (F2)
- [ ] T221 [US7] Remove the duplicate button definition and the triplicated help-text rule from `apps/web/src/styles.css`, and route the four one-off button styles through the shared component (F5)
- [ ] T222 [US7] Fix the global focus indicator contrast in `apps/web/src/styles.css`, which currently fails on every light surface (F8)
- [ ] T223 [P] [US7] Replace the hardcoded colours that do not respond to theme across `apps/web/src/styles.css` (F6, FR-052)
- [ ] T224 [US7] Route the two hand-rolled dialogs in `apps/web/src/team/preview/MaterialPreview.tsx` and `apps/web/src/team/landings/LandingFullView.tsx` through the shared modal, and replace the three native confirmations in `apps/web/src/App.tsx` and `apps/web/src/landing-viewer/useLandingViewer.ts` (F4, FR-051)
- [ ] T225 [US7] Extend the focusable-element set in `apps/web/src/components/Modal.tsx` to cover editable regions, media controls and frames, and mark the rest of the tree inert while a dialog is open (F10)
- [ ] T226 [US7] Remove the live-region announcement from the three job lists in `apps/web/src/App.tsx`, `apps/web/src/transcription/TranscriptionPage.tsx` and `apps/web/src/landing/LandingOptimizerPage.tsx`, replacing it with one throttled status line, and make error notifications assertive (F9)
- [ ] T227 [P] [US7] Add arrow-key navigation and a roving tab stop to the segmented control in `apps/web/src/components/ui.tsx` (F11)
- [ ] T228 [P] [US7] Make range selection keyboard-operable in `apps/web/src/components/JobRow.tsx` and fix the controlled-input warning (F11)
- [ ] T229 [P] [US7] Give the language switch a proper role and pressed state in `apps/web/src/App.tsx`, and stop activating disabled tool cards in `apps/web/src/HomePage.tsx` (F11)
- [ ] T230 [US7] Add plural-rule handling to `apps/web/src/i18n.ts` for the five count strings and remove the hand-coded special case (F12, FR-054)
- [ ] T231 [US7] Delete the unused translations from `apps/web/src/i18n.ts` after reproducing the count with the new checker (F12, FR-056)
- [ ] T232 [US7] Emit stable codes for the eleven messages currently translated by matching English wording, in `apps/agent/src/` and `apps/web/src/App.tsx` and `apps/web/src/components/JobRow.tsx` (F13, FR-055)
- [ ] T233 [P] [US7] Move the remaining untranslated literals and page titles into the translations across `apps/web/src/` (F14)
- [ ] T234 [US7] Make the document language, title, description and pre-load appearance match the user in `apps/web/index.html` and `apps/web/src/i18n.ts` (F7, FR-057)
- [ ] T235 [US7] Drive the accessibility violation baseline to zero and flip the sweep from report-only to blocking in `scripts/verify-all.mjs` (SC-016)

**Checkpoint**: One dialog, one theme system, one set of scales, two correct languages, zero blocking accessibility findings.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T236 [P] Consolidate the temp-directory setup copy-pasted into 41 test files onto the shared helper in `tests/support/` (B7, FR-021)
- [ ] T237 [P] Replace the real sleeps at the twenty sites listed under B8 with fake timers or `tests/support/wait.ts`, starting with `tests/agent-http.test.ts`, `tests/queue.test.ts`, `tests/stop-all.test.ts`, `tests/estimate.test.ts` and `tests/landing-preview-catalog.test.ts` (FR-022)
- [ ] T238 [P] Fix the load-dependent cleanup flake in `tests/transcription-auto-translation.test.ts` (A18)
- [ ] T239 [P] Replace the wall-clock assertions in `tests/catalog-benchmark.test.ts`, `tests/creative-library-benchmark.test.ts` and `tests/team-landing-gallery.test.tsx` with the recorded performance budgets (FR-022)
- [ ] T240 Empty the type-check exclusion lists in `tsconfig.check.json` and `tsconfig.scripts.json`
- [ ] T241 [P] Add tests for every module named in `coverage-critical.json` that no test imports today, working the list in `specs/009-release-hardening-pass/findings.md` §B; modules outside that file are out of scope here and are governed by the coverage ratchet instead
- [ ] T242 [P] Update `AGENTS.md` and `README.md` to describe the single verification command and the two forms
- [ ] T243 [P] Update `.specify/memory/constitution.md` to retire the "Known CI gaps" paragraph, which this feature closes
- [ ] T244 Record the disposition of every audit finding in `specs/009-release-hardening-pass/findings.md` — resolved, or accepted with a stated reason (SC-019)
- [ ] T245 Run `specs/009-release-hardening-pass/quickstart.md` end to end on macOS
- [ ] T246 Run `specs/009-release-hardening-pass/quickstart.md` end to end on Windows, including the orphaned-suspended-process check (FR-009)
- [ ] T247 Substitute the real Developer ID profile into `scripts/sign-mac-app.sh` and the real certificate secret into `.github/workflows/release-windows.yml`, then re-run publisher verification on a clean machine on both platforms (SC-010)

---

## Phase 11: Field reports (Priority: P1 — reported by users, 2026-08-25)

**Goal**: Two complaints arrived from real use. A compression that doubled a
227 MB file to ~500 MB, and a Compress button greyed out as "already running"
above a panel reading 0 queued, 0 processing, 0 done. Both are covered here,
plus the reason diagnosing the second cost an hour of reading code.

**Scope discipline**: these are fixes, not features. Nothing here adds a
capability; each item removes a way the application misleads someone or a way we
cannot see what it did.

### The blocked queue that is doing nothing (complaint 2)

- [x] F1 [FIELD] Report queue liveness in `/api/diagnostics` — `running`, the activity kind, per-status job counts, the batch id and whether the drain watchdog is armed — so the next report of this is answered by reading a page rather than the source (`apps/agent/src/server/app.ts`)
- [x] F2 [FIELD] Make the drain watchdog guard the _activity_, not only the batch, in `apps/agent/src/queue/queue.ts`: it currently arms on `start()` and retires whenever no batch is open, so an activity stranded without a batch keeps `running` true forever and the one thing that could clear it has already stopped looking
- [x] F3 [FIELD] Arm the watchdog whenever the queue becomes non-idle rather than only inside `start()`, so a queue that is already stuck can recover without the button the stuck state disables
- [x] F4 [FIELD] Derive `running()` from one source in `apps/agent/src/queue/queue.ts` — an activity naming a job that no longer exists, or that has reached a terminal status, is not activity — so the panel counters and the busy flag cannot disagree
- [x] F5 [P] [FIELD] Create `tests/queue-stuck-recovery.test.ts` staging each way the two can diverge (activity pointing at a removed job, at a completed job, a batch whose jobs are gone) and asserting the queue reports itself idle and accepts a start
- [x] F6 [P] [FIELD] Say what is actually happening when the interface is blocked in `apps/web/src/App.tsx`: a busy flag with nothing queued, processing or in flight is a stuck queue, not a busy one, and the copy must not claim otherwise

### A compression that made the file bigger (complaint 1)

- [x] F7 [FIELD] Warn before the estimate, not after, in `apps/agent/src/queue/queue.ts`: `sourceCodec` and `sourceBitrate` are known from the ffprobe that runs on add, so a file that will almost certainly grow — already-efficient source codec, or a target bitrate above the source's — can be flagged the moment it is added rather than after a long estimate the user does not wait for
- [x] F8 [FIELD] Add the never-larger ceiling to `apps/agent/src/ffmpeg/encoder.ts` and the compressor routes: when the finished output is larger than the source, keep the source and report that plainly, because a tool called "compress" returning a bigger file is a failure whatever the settings said
- [x] F9 [P] [FIELD] Explain the codec change where the choice is made in `apps/web/src/components/SettingsPanel.tsx` — an H.265 source re-encoded to H.264 needs roughly twice the bitrate for the same picture, which is a property of the format and not a bug, and the user currently has no way to know it
- [x] F10 [P] [FIELD] Show the resulting duration next to the image-embedding controls in `apps/web/src/components/ImageEmbeddingSection.tsx`: a 40–50 minute default tail turns a 2.5 minute video into a 47 minute file, and the panel says neither the range nor the total
- [x] F11 [P] [FIELD] Create `tests/output-never-larger.test.ts` covering the ceiling, the pre-estimate warning for an efficient source, and the case where growth is legitimate and the user asked for it

**Checkpoint**: the tool cannot silently hand back a bigger file, it says why a
file will grow before the work starts, and a stuck queue is both visible in
diagnostics and able to recover on its own.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)** — no dependencies. **T001 gates Phase 6**; the type-check gate (T003–T009) gates T032 and therefore SC-003; **T014a–T014d close the two live-confirmed security holes and should land in the first week**.
- **Foundational (Phase 2)** — depends on Setup. **Blocks every user story.**
- **US1 (Phase 3)** — depends on Foundational. The MVP.
- **US2 (Phase 4)** — depends on Foundational. Independent of US1 except T093, which wants the multiplexed stream from T072–T078.
- **US3 (Phase 5)** — depends on Foundational; its end-to-end tasks (T110–T113) want US1's harness pieces.
- **US4 (Phase 6)** — depends on Foundational and on **T001**. T126–T136 are independent of US1; T137–T140 are independent of everything.
- **US5 (Phase 7)** — its four wave-zero implementation items now live in Phase 1 as T014a–T014d; the tests T144–T152a depend on nothing beyond those. **T172–T178 (the path ledger) depend on US1's queue-restoration semantics being settled** — do not start them before T062 and T075 are done. T166–T168 pair with US1's stream work.
- **US6 (Phase 8)** — depends on US4's state writer (T135), inside which reconciliation lives.
- **US7 (Phase 9)** — depends on Foundational; T213 wants T023's shared fake.
- **Polish (Phase 10)** — depends on all desired stories. T247 is blocked on external procurement only.

### Ordering constraints inside stories

- **US1's compressor collapse is strictly sequential**: T039 → T057 → T058 → T059 → T060. Characterise, then shadow, then invert. At no point does the code run on an un-cross-checked representation.
- **US1's transitions are permissive before strict**: T034–T038 (record) must complete and reconcile before T049–T052 (enforce). Enforcing a wrong table is the one real risk, and this is the mitigation.
- **US2's T087 → T088 → T089** are one chain, and T089 must follow T059 because the estimate early return sits inside the method the collapse rewrites.
- **US5's ledger is prerequisite-ordered**: T169–T171 → T172 → T173–T175 → T176 (observe) → T177 → T178 (enforce). The observe cycle is not optional.
- **US5's dependency gate lands report-only and flips blocking in the same change** (T120), because T012 has already cleared the tree. Never land a gate that is already red.
- **T119 is discovery only.** It produces the Windows failure list; T119a and T119b consume it. Do not merge them back into one task — the scope is unknowable until the list exists.

### Parallel opportunities

- Setup: T002–T005, T010, T011, T013 all in parallel.
- Foundational: T015, T016, T019, T021, T023, T024, T025 in parallel; T030 alongside T031.
- US1: all eight test tasks (T039–T048) in parallel; T050–T052 in parallel; T062, T063, T064, T065 in parallel.
- US2: all six test tasks (T081–T086) in parallel.
- US3: T094–T096 in parallel.
- US4: all five test tasks (T121–T125) in parallel; T131, T132, T136, T141, T142, T143 in parallel.
- US5: all twelve test tasks (T144–T152a) in parallel; the entire remainder block T181–T189 in parallel. **T187 (backend grants) is a different runtime with zero coupling and can start on day one.**
- US7: T208–T210 in parallel; T223, T227, T228, T229, T233 in parallel.

---

## Parallel Example: User Story 1

```bash
# All eight test tasks together — different files, no shared dependency:
Task: "Create tests/compressor-activity.test.ts characterising today's behaviour against the A11 gap list"
Task: "Add compression drivers to tests/support/lifecycle-drivers.ts"
Task: "Add the six remaining tool drivers to tests/support/lifecycle-drivers.ts"
Task: "Create tests/support/interleaving-scenarios.ts with a >=20-step scenario"
Task: "Create tests/stop-releases-machine.test.ts using the machine probe"
Task: "Create tests/agent-restart-recovery.test.ts"
Task: "Create tests/start-serialisation.test.ts"
Task: "Create tests/stream-multiplex.test.ts"

# Then the three independent strict flips together:
Task: "Flip transition() to strict in apps/agent/src/queue/transcription-queue.ts"
Task: "Flip transition() to strict in apps/agent/src/landing/optimizer.ts"
Task: "Flip transition() to strict in apps/agent/src/landing-preview/catalog.ts"
```

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 Setup — the type-check gate especially, since nothing enforces the lifecycle tables without it.
2. Phase 2 Foundational — lifecycle declaration, machine probe, shared fixtures.
3. Phase 3 User Story 1.
4. **Stop and validate**: run `quickstart.md` §1 on both platforms. Every stop leaves the machine quiet, every interleaving checkpoint agrees, every tool can be stopped.
5. Ship. This alone is the guarantee the feature exists to provide.

### Incremental delivery

Setup + Foundational → US1 (MVP) → US3 (makes everything after it cheap to keep true) → US2 → US5 wave zero → US4 → the rest of US5 → US6 → US7. US3 is placed third deliberately: it is what stops the earlier work from silently regressing while the later work happens.

### Parallel team strategy

After Foundational: one developer on US1 (the largest and most sequential), one on US3 plus US5's wave zero, one on US2 plus US4's independent half. US5's backend grant work (T187) and the signing chains (T157–T162) are genuinely uncoupled and can be picked up by anyone at any time.

---

## Notes

- **Reproduce before fixing.** T001 exists because the audit's loudest interface conclusions were read, not observed. A fix for a bug that does not exist is worse than no fix.
- **Prefer a rule over a test.** Where a task adds a lint restriction or a derived membership check rather than a checklist, that is deliberate — the existing spawn-import ban is the model.
- **Honest downgrades are in scope.** T070 deliberately does not add persistence; the spec's Assumptions rule out new capability, so the fix is to stop implying durability rather than to build it.
- 257 tasks. Commit per task or per logical group; every checkpoint is a valid place to stop and validate.
