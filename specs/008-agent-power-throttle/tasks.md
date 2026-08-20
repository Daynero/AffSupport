---

description: "Task list for Local Agent Power Throttle"
---

# Tasks: Local Agent Power Throttle

**Input**: Design documents from `/specs/008-agent-power-throttle/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Included. Not an optional extra here — the constitution makes `npm test` a mandatory pre-PR gate, and [data-model.md](./data-model.md#invariants) names a specific test for each of the fourteen invariants. Every test task below traces to a named invariant or contract matrix row.

**Organization**: Tasks are grouped by user story so each can be implemented, tested, and demoed on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: `[US1]`–`[US4]`, mapping to the user stories in [spec.md](./spec.md)
- Every task names its exact file path

## Path Conventions

Monorepo (npm workspaces), per [plan.md](./plan.md#source-code-repository-root):

- Contract: `packages/shared/src/`
- Agent: `apps/agent/src/`
- Web: `apps/web/src/`
- Tests: central `tests/` directory, `*.test.ts` / `*.test.tsx` — never co-located

---

## Phase 1: Setup (Shared Contract)

**Purpose**: Put the contract in place first, because both the agent and the web app compile against it. Nothing else can start until `shared` builds.

- [X] T001 [P] Add `POWER_LIMIT_MIN`, `POWER_LIMIT_MAX`, `DEFAULT_POWER_LIMIT` and `clampPowerLimit()` to `packages/shared/src/types.ts` per [contracts/shared-types.md](./contracts/shared-types.md#bounds-and-defaults) — these are the canonical bounds; no other module may compare against 20 or 100
- [X] T002 [P] Add `PowerMode`, `PowerActivity`, `PowerSample` (discriminated union), `PowerState` and `PowerEvent` to `packages/shared/src/types.ts` per [contracts/shared-types.md](./contracts/shared-types.md#state-types)
- [X] T003 [P] Add `parsePowerLimitRequest()` and `parsePersistedPowerState()` guards to `packages/shared/src/types.ts` — both return the `{ ok: true; value } | { ok: false; error }` shape used across the codebase, never throw, never cast
- [X] T004 Add `power: 1` to `AGENT_TOOL_CONTRACTS` and `power: { power: 1 }` to `WEB_TOOL_REQUIREMENTS` in `packages/shared/src/release.ts`. Do **not** touch `AGENT_API_VERSION` — see [research R9](./research.md#r9--contract-versioning-strategy)
- [X] T005 [P] Add `tests/power-contract.test.ts` covering the `clampPowerLimit` behaviour table and both parse guards (rejects non-object / missing key / string / `NaN` / `Infinity`; **accepts and clamps** finite out-of-range values)
- [X] T006 Run `npm run build -w @video-compressor/shared` and commit the regenerated `packages/shared/dist` — it is committed, and Principle II requires downstream gates to validate against current constants, not a stale `dist`

**Checkpoint**: Contract compiles and is consumable by both workspaces.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The governor skeleton, the managed-spawn seam, and the read-only HTTP surface. Both P1 stories build directly on this.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T007 Create `apps/agent/src/power/governor.ts` with the `PowerGovernor` class: holds `limitPercent` in memory (default `DEFAULT_POWER_LIMIT`), the Managed Child registry, `state(): PowerState`, `register()` / `release()`, and a no-op `shutdown()`. Throttling and sampling are added by later phases — this phase only establishes the single source of truth
- [X] T008 Create `apps/agent/src/power/spawn.ts` exporting `spawnManaged(cmd, args, opts, governor)`: spawns with `shell: false`, registers the child with the governor, and guarantees deregistration in a `finally` on `close` **and** on `error` ([invariant 2](./data-model.md#invariants)). Returns the same `{ child, done }` shape the existing `encodeVideo` helper uses so call sites change minimally
- [X] T009 Add `power: PowerGovernor` to the `ToolContext` interface in `apps/agent/src/server/tools.ts` — the doc comment already scopes this to "server-wide facilities every tool module may rely on", which is exactly what the governor is. Do **not** add it to the `ToolModule` list; it is infrastructure, not a tool, and would pollute the `/health` busy flag
- [X] T010 Create `apps/agent/src/power/routes.ts` with `registerPowerRoutes(app, { governor, allowedOrigins })` exposing `GET /api/power` returning the `PowerState` snapshot, per [contracts/agent-http.md](./contracts/agent-http.md#get-apipower)
- [X] T011 Add a `PowerState` `EventChannel` to `apps/agent/src/power/routes.ts` and serve `GET /api/power/events` through it, reusing `apps/agent/src/server/sse.ts` with its per-client write guard. Frames carry `sample.availability: 'warming-up'` until Phase 4 adds real sampling
- [X] T012 Wire the routes in `apps/agent/src/server/app.ts` next to the health routes, and **leave `/api/power*` out of `ENTITLEMENT_EXEMPT_ROUTES`** — the deliberate call recorded in [research R7](./research.md#r7--entitlement-gating-and-the-degraded-ui-state)
- [X] T013 Construct the governor in `apps/agent/src/index.ts`, pass it into `ToolContext`, and add `governor.shutdown()` to the existing shutdown chain
- [X] T014 [P] Migrate `apps/agent/src/ffmpeg/encoder.ts` (`encodeVideo`) to `spawnManaged`
- [X] T015 [P] Migrate `apps/agent/src/whisper/transcriber.ts` (both the ffmpeg WAV extraction and the whisper run) to `spawnManaged`
- [X] T016 [P] Migrate `apps/agent/src/transcription/media-preview.ts` to `spawnManaged` — despite the name it runs a full ffmpeg transcode with progress reporting, and it was missed in the first pass over the spawn sites
- [X] T017 [P] Migrate `apps/agent/src/media-actions/image-converter.ts` to `spawnManaged`
- [X] T018 [P] Migrate `apps/agent/src/landing/workspace.ts` and `apps/agent/src/landing/images.ts` to `spawnManaged`
- [X] T019 [P] Migrate `apps/agent/src/translation/translator.ts` and `apps/agent/src/translation/aligner.ts` to `spawnManaged`
- [X] T020 [P] Migrate `apps/agent/src/estimate/worker.ts` (both spawn sites) and `apps/agent/src/images/static-edges.ts` to `spawnManaged`
- [X] T021 [P] Register the Playwright browser process tree from `apps/agent/src/landing-preview/catalog.ts` with the governor — Playwright owns its own spawn, so register the launched browser's PID rather than routing it through `spawnManaged`
- [X] T022 Add an `@typescript-eslint/no-restricted-imports` rule to `eslint.config.mjs` banning `node:child_process` under `apps/agent/src`, with `allowTypeImports: true` and an allowlist of `platform/**`, `power/**`, `ffmpeg/tools.ts`, `whisper/tools.ts`, `files/picker.ts` and `files/dropped-source.ts` — the four files that legitimately spawn unmanaged probes and dialogs. `allowTypeImports` matters because `queue/queue.ts:4` carries a type-only import that the base rule would otherwise reject. Verify with `npm run lint` before moving on; a too-narrow rule blocks the branch on a mandatory gate ([research R6](./research.md#r6--making-the-budget-genuinely-shared-and-automatic-for-future-tools))
- [X] T023 [P] Add `tests/power-spawn-coverage.test.ts` asserting that no module outside the allowlist imports `node:child_process` for a value import, and that no module outside `power/` and `platform/` calls `pauseProcess` / `resumeProcess` ([invariant 10](./data-model.md#invariants))
- [X] T024 [P] Add `tests/power-routes.test.ts` covering the `GET /api/power`, auth, origin, and entitlement rows of the [route matrix](./contracts/agent-http.md#route-level-test-matrix), assembled against a real Fastify instance the way `tests/agent-http.test.ts` does it

**Checkpoint**: The agent knows every heavy child it owns and can report a snapshot. Nothing is throttled yet.

---

## Phase 3: User Story 1 — Cap Soty so the computer stays usable (Priority: P1) 🎯 MVP

**Goal**: One lever that actually reduces what Soty consumes, applied as a single shared budget across every local tool, reaching work that is already running — without breaking anything that already runs.

**Independent Test**: Start a long compression at 100%, pull the lever to 20%, and confirm consumption falls toward the cap within 5 s while the job keeps running and finishes with byte-identical output. Then run two tools at once at 50% and confirm they share one budget rather than taking 50% each.

### Tests for User Story 1

- [X] T025 [P] [US1] Add `tests/power-governor.test.ts` with the budget-math cases: `threadBudget = max(1, round(limit/100 × cores))`, the low-core floor ([invariant 9](./data-model.md#invariants)), `mode` derivation, and **[invariant 12](./data-model.md#invariants)** — at 100% the budget yields `null` thread arguments, makes no priority call, and `scaleTimeout(ms) === ms`
- [X] T026 [P] [US1] Extend `tests/power-governor.test.ts` with duty-cycler cases under `vi.useFakeTimers`: on/off windows for 20/50/100%, the ≥ 50 ms on-window floor, and that a 100% limit sends **no** signals at all
- [X] T027 [P] [US1] Extend `tests/power-governor.test.ts` with the safety invariants: resumes every suspended child on shutdown ([1](./data-model.md#invariants)), deregisters on spawn error and non-zero exit ([2](./data-model.md#invariants)), never signals a PID after its `close` event ([3](./data-model.md#invariants)), and two concurrent children share one budget ([4](./data-model.md#invariants))
- [X] T028 [P] [US1] Add `tests/power-queue-integration.test.ts` for the hold protocol: the duty cycler does not resume a child under an outstanding hold ([10](./data-model.md#invariants)), and cancelling a duty-suspended encode resumes it first so `SIGTERM` is actually handled and the 2 s `SIGKILL` escalation is not reached ([11](./data-model.md#invariants))
- [X] T029 [P] [US1] Add `tests/power-timeout-scaling.test.ts` asserting every managed-work wall-clock budget is divided by `dutyOnFraction` while limited and left untouched at 100% ([13](./data-model.md#invariants))
- [X] T030 [P] [US1] Add `tests/power-scope.test.ts` asserting the limit governs local processing only: team-bridge transfers and the agent's own HTTP request handling are not registered with the governor and are never suspended ([14](./data-model.md#invariants), FR-020)
- [X] T031 [P] [US1] Extend `tests/power-routes.test.ts` with the `POST /api/power/limit` rows: 40 → 200, 5 → clamped 20, 500 → clamped 100, `{}` → `400 POWER_LIMIT_INVALID`, and a broadcast frame reaching a connected SSE client

### Implementation for User Story 1

- [X] T032 [US1] Add CPU-budget derivation to `apps/agent/src/power/governor.ts`: `threadBudget`, `dutyOnFraction`, `priority` and `timeoutScale`, recomputed whenever the limit changes, per [data-model.md](./data-model.md#entity-cpu-budget). At 100% `threadBudget` and `priority` are `null` and `timeoutScale` is `1` — the "off" state must be indistinguishable from today ([research R13](./research.md#r13--unrestricted-must-mean-exactly-as-today))
- [X] T033 [US1] Add the hold protocol to `apps/agent/src/power/governor.ts`: `hold(child, reason)` returning a release handle, and `resumeForTermination(child)` which resumes and pins a child resumed. The governor becomes the **only** writer of suspend state ([research R11](./research.md#r11--one-owner-of-suspend-state))
- [X] T034 [US1] Add the duty cycler to `apps/agent/src/power/governor.ts`: a 200 ms period suspending/resuming every registered child and its descendants via the platform layer, honouring outstanding holds and the on-window floor from [research R10](./research.md#r10--keeping-throughput-non-zero-at-the-floor). Timers `.unref()`'d; genuinely inactive at 100%
- [X] T035 [US1] Migrate `apps/agent/src/queue/queue.ts` off direct suspension: the estimate-prioritization pause at lines 1170-1199 takes `governor.hold(child, 'estimate-priority')` in place of `pauseProcess`, and the cancel/shutdown paths at lines 559 and 683 call `governor.resumeForTermination(child)` before `SIGTERM`. Without this the cycler and the queue fight over the same process and estimate prioritization silently stops working
- [X] T036 [US1] Add `scaleTimeout(ms)` to `apps/agent/src/power/governor.ts` and apply it to every wall-clock budget covering managed work: `RENDER_TIMEOUT_MS` and `NAVIGATION_TIMEOUT_MS` in `apps/agent/src/landing-preview/renderer.ts:10,12`, `FS_OP_TIMEOUT_MS` in `apps/agent/src/landing-preview/scanner.ts:15`, the `RENDER_TIMEOUT` watchdog in `apps/agent/src/team-bridge/landing-gallery.ts:52`, and the 2 s `SIGKILL` escalation in `apps/agent/src/queue/queue.ts:688`. An unscaled deadline turns a slowdown into a failure ([research R12](./research.md#r12--wall-clock-timeouts-under-a-duty-cycle))
- [X] T037 [US1] Apply the thread budget in `apps/agent/src/ffmpeg/presets.ts` — `-threads` and `-filter_threads` **only when a limit is in force**. At 100% the argv must be byte-identical to today's, which currently carries no thread flag at all
- [X] T038 [US1] Feed the thread budget into `buildWhisperArgs` in `apps/agent/src/whisper/transcriber.ts`. Keep the existing `Math.max(4, os.cpus().length - 2)` default when the budget is `null`, so unrestricted transcription does not silently become hotter than it is today
- [X] T039 [US1] Set the child's process priority in `apps/agent/src/power/spawn.ts` via `os.setPriority`, at spawn time only and only when limited — never restored downward, because POSIX forbids an unprivileged process from lowering its own nice value ([research R2](./research.md#r2--holding-a-ceiling-on-already-running-work))
- [X] T040 [US1] Add `POST /api/power/limit` to `apps/agent/src/power/routes.ts`: parse with `parsePowerLimitRequest`, clamp, apply, retune the cycler, broadcast, return the snapshot. Errors use the machine codes in [contracts/agent-http.md](./contracts/agent-http.md#post-apipowerlimit)
- [X] T041 [P] [US1] Add `fetchPowerState()`, `setPowerLimit()` and `powerEventsUrl()` to `apps/web/src/api/client.ts` using the existing `request` / `requestBody` → `assertOk` wrappers
- [X] T042 [US1] Create `apps/web/src/lib/power.tsx` with `PowerProvider`, `usePower()` (throws outside its provider) and `PowerContextOverride`, following the house context idiom, per [contracts/ui-contract.md](./contracts/ui-contract.md#state-store--appswebsrclibpowertsx)
- [X] T043 [US1] Create `apps/web/src/components/PowerLever.tsx`: vertical thrust lever with `role="slider"`, `aria-orientation="vertical"`, full keyboard support (arrows ±1, PageUp/Down ±10, Home/End), pointer drag with capture, click-to-position, and a labelled 20/40/60/80/100 scale. One inline style only — the computed travel offset
- [X] T044 [US1] Create `apps/web/src/components/PowerThrottle.tsx`: header button + popover shell with `aria-expanded` / `aria-haspopup`, closing on second click, `Escape`, and outside pointer-down, with focus moved in on open and restored on close (FR-002)
- [X] T045 [US1] Mount `<PowerThrottle />` immediately before `<ThemeToggle />` in the `topbar-actions` cluster in `apps/web/src/App.tsx`, and wrap the tree in `PowerProvider` (FR-001)
- [X] T046 [US1] Implement optimistic-with-rollback in `apps/web/src/lib/power.tsx`: local value updates instantly, the POST is debounced ~200 ms, the response is authoritative (so a clamped value self-corrects), and a failure returns the lever to the last effective value with an error surfaced (FR-006)
- [X] T047 [P] [US1] Add the lever/panel i18n keys (`powerControl`, `powerPanelTitle`, `powerLeverLabel`, `powerLimitAt`, `powerLimitFailed`, `powerScaleMark`) to **both** the `en` and `uk` blocks in `apps/web/src/i18n.ts`
- [X] T048 [P] [US1] Add `.power-toggle`, `.power-panel` and `.power-lever` rules to `apps/web/src/styles.css` using CSS custom properties so both themes are covered by the existing `data-theme` mechanism
- [X] T049 [P] [US1] Add `tests/power-panel.test.tsx` (jsdom docblock) covering the lever half of the [UI matrix](./contracts/ui-contract.md#ui-test-matrix): roles and aria values, each keyboard key, drag issuing one debounced request, rollback on rejection, and panel open/close focus behaviour

**Checkpoint**: US1 is demoable end to end on macOS. The lever caps running work, nothing that already worked has broken, and the readout is not built yet.

---

## Phase 4: User Story 2 — See what Soty is consuming right now (Priority: P1)

**Goal**: A live percentage under the lever that tells the truth — including telling the user when it cannot.

**Independent Test**: Open the panel with nothing running and see a near-zero idle figure; start a job and watch it rise and keep updating; move the lever and watch it follow; stop the agent and confirm the panel says unavailable rather than showing a stale number.

### Tests for User Story 2

- [X] T050 [P] [US2] Add `tests/power-sampler.test.ts` covering the share formula `Δcpu / (Δwall × cores)`, and [invariant 7](./data-model.md#invariants) — reports `warming-up` rather than `0` before the first delta exists, and `error` when the probe fails
- [X] T051 [P] [US2] Add `tests/power-process-tree.test.ts` covering the descendant walk against mocked platform probe output for both macOS and Windows shapes, including an orphaned-PID row
- [X] T052 [P] [US2] Extend `tests/power-routes.test.ts` with the sampling lifecycle: the tick starts on the first SSE subscriber and stops when the last disconnects (FR-019), observed via the probe not being called again
- [X] T053 [P] [US2] Extend `tests/power-routes.test.ts` with the multi-client case: two concurrent SSE subscribers both receive the frame produced by a single limit change (FR-023)

### Implementation for User Story 2

- [X] T054 [P] [US2] Create `apps/agent/src/power/process-tree.ts`: PID → descendant PIDs, `ps -ax -o pid=,ppid=` on macOS and `Get-CimInstance Win32_Process` on Windows, behind the platform layer. Refreshed on a slower cadence than the sample tick since the tree rarely changes
- [X] T055 [US2] Create `apps/agent/src/power/sampler.ts`: batch one cumulative-CPU-time probe per tick across all tracked PIDs, add the agent's own `process.cpuUsage()`, and difference consecutive samples into a `PowerSample`. Use **cumulative CPU time**, never macOS `ps %cpu` — that column is a decaying lifetime average and would make the readout lag the lever by tens of seconds ([research R5](./research.md#r5--measuring-what-soty-is-consuming))
- [X] T056 [US2] Refcount the sampler to SSE subscribers in `apps/agent/src/power/routes.ts`: start the 1 s tick on 0 → 1, stop it on 1 → 0, timer `.unref()`'d (FR-019, SC-010)
- [X] T057 [US2] Broadcast a `PowerState` frame per tick, plus an immediate extra frame on any limit change. Derive `activity` from the child registry **or** any tool module's `busy()` flag, so a job in `preparing-images` with no child yet does not read as idle ([data-model](./data-model.md#entity-consumption-sample))
- [X] T058 [US2] Create `apps/web/src/components/PowerReadout.tsx` rendering strictly off `sample.availability` and `sample.activity` per the [readout table](./contracts/ui-contract.md#powerreadout--the-live-figure), with `aria-live="polite"`. No percentage is ever rendered from a non-`ok` sample
- [X] T059 [US2] Subscribe `apps/web/src/lib/power.tsx` to the SSE channel through the existing `useAgentEventStream` hook, exposed as a refcounted `watch()` so the stream is open only while the panel is (no polling)
- [X] T060 [P] [US2] Add the readout i18n keys (`powerUsageActive`, `powerUsageIdle`, `powerUsageMeasuring`, `powerUsageUnsupported`, `powerUsageUnavailable`, `powerThrottleUnsupported`) to both `en` and `uk` in `apps/web/src/i18n.ts`
- [X] T061 [P] [US2] Add `.power-readout` styling to `apps/web/src/styles.css`
- [X] T062 [P] [US2] Extend `tests/power-panel.test.tsx` with the readout rows of the [UI matrix](./contracts/ui-contract.md#ui-test-matrix): a percentage for `ok`, and **no percentage anywhere in the output** for `warming-up` / `error` / `unsupported`, plus `watch()` teardown when the panel closes

**Checkpoint**: Both P1 stories work. The feature is usable and honest on macOS.

---

## Phase 5: User Story 3 — The setting persists and is discoverable (Priority: P2)

**Goal**: Soty remembers the limit across restarts, per machine, and says so on the header icon without the panel being opened.

**Independent Test**: Set 40%, restart the app and the agent, and confirm the limit is still 40 and the header icon shows the reduced state. Corrupt `power.json` and confirm the agent falls back to unrestricted rather than a nonsense value.

### Tests for User Story 3

- [X] T063 [P] [US3] Add `tests/power-persistence.test.ts` using `mkdtemp` + an `afterEach` recursive cleanup: round-trip save/load, [invariant 6](./data-model.md#invariants) (corrupt / wrong-shape / out-of-range → default 100%, logged once), and [invariant 5](./data-model.md#invariants) (a limit that could not be persisted is **not** applied, and a following `GET` still shows the old value)
- [X] T064 [P] [US3] Extend `tests/power-routes.test.ts` with the `500 POWER_PERSIST_FAILED` row against an unwritable store
- [X] T065 [P] [US3] Extend `tests/power-panel.test.tsx` with the offline case: a limit chosen while the agent is unreachable is retained and sent once the connection returns (FR-021)

### Implementation for User Story 3

- [X] T066 [US3] Create `apps/agent/src/power/store.ts`: load/save `power.json` in the application-support root, written temp + `rename`, with an `AGENT_POWER_STATE_PATH` override mirroring the existing `AGENT_STATE_PATH`. Read is untrusted and goes through `parsePersistedPowerState`
- [X] T067 [US3] Load the persisted limit during governor construction in `apps/agent/src/index.ts`, and persist **before** applying in the `POST` handler so a write failure leaves the in-memory limit untouched (FR-006)
- [X] T068 [US3] Add deferred application to `apps/web/src/lib/power.tsx`: a limit chosen while the agent is unreachable is held and posted on reconnect rather than discarded, so the user's choice is never silently lost (FR-021)
- [X] T069 [US3] Add the reduced-limit indication to `apps/web/src/components/PowerThrottle.tsx` (`data-limited` on the button plus a `title` naming the current percentage) so a limit set weeks ago never reads as "Soty is broken" (FR-005)
- [X] T070 [P] [US3] Style the reduced-limit button state in `apps/web/src/styles.css`
- [X] T071 [P] [US3] Extend `tests/power-panel.test.tsx` with the header-indication rows: reduced limit shows the indication, 100% does not

**Checkpoint**: The setting survives restarts, survives a disconnected agent, and is visible at a glance.

---

## Phase 6: User Story 4 — Works the same on Windows and macOS (Priority: P2)

**Goal**: Make live throttling real on Windows, where there is no `SIGSTOP`. Without this phase, the whole live-throttle half of the feature is macOS-only.

**Independent Test**: Run the US1 scenario on Windows with the same file and limit as macOS and confirm consumption is capped within 15 pp of the macOS result, with no orphaned suspended process after killing the agent mid-job.

### Tests for User Story 4

- [X] T072 [P] [US4] Add `tests/power-windows-suspend.test.ts` covering the helper protocol against a mocked stdin/stdout child: PID validation rejects anything non-integer before writing, commands are framed correctly, and a helper crash is recovered by respawn rather than leaving the governor wedged
- [X] T073 [P] [US4] Extend `tests/agent-capabilities.test.ts` asserting `capabilities().processPause` is now `true` on win32 and that `PowerState.throttlingSupported` follows it

### Implementation for User Story 4

- [X] T074 [US4] Create `apps/agent/src/platform/windows-suspend.ts`: a long-lived `powershell.exe` helper P/Invoking `NtSuspendProcess` / `NtResumeProcess`, spawned `shell: false` with a fixed argv and `windowsHide: true`, mirroring `runWindowsPicker` in `apps/agent/src/files/picker.ts`. Spawned lazily — only when the limit drops below 100% — so users who never throttle never pay for it. PIDs are validated as positive integers before being written to stdin; the script itself is a compile-time constant, never assembled from input
- [X] T075 [US4] Add SIGTERM → SIGKILL escalation and `.unref()`'d timers to the helper's lifecycle, matching the existing watchdog pattern (Principle IV)
- [X] T076 [US4] Flip `processPause` to `true` for `win32` in `capabilities()` in `apps/agent/src/platform/platform.ts`, and route `pauseProcess` / `resumeProcess` through the helper on Windows while POSIX keeps using `SIGSTOP` / `SIGCONT`. Update the interface doc comment, which currently states Windows cannot do this
- [X] T077 [US4] Add the Windows branch of the cumulative-CPU-time probe to `apps/agent/src/power/sampler.ts`, served by the same resident helper so Windows adds **zero** extra process spawns per tick
- [X] T078 [US4] Add `throttlingSupported: false` handling to `apps/web/src/components/PowerReadout.tsx` — copy stating the limit applies to newly started work only. It should be unreachable on both shipping platforms after T076, but the state must exist rather than silently claiming a limit is in force
- [X] T079 [US4] Verify the debt this repays: the compressor's suspend-during-estimates path in `apps/agent/src/queue/queue.ts` is a silent no-op on Windows today. Confirm it now genuinely suspends through the hold protocol, and extend `tests/power-queue-integration.test.ts` with a Windows-capability case so it stays working

**Checkpoint**: All four stories work, on both platforms.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T080 [P] Add `power_panel_opened` and `power_limit_changed` to the `AnalyticsEventName` union and `AnalyticsEventProperties` map in `apps/web/src/analytics/events.ts`, with a `limit_percent: [20, 100]` entry in the numeric-bounds map. Track the **settled** value after debounce, not every intermediate drag position (FR-024)
- [X] T081 [P] Emit both events from `apps/web/src/components/PowerThrottle.tsx` and `apps/web/src/lib/power.tsx` via `analytics.track`
- [X] T082 [P] Document the feature in `AGENTS.md`: what the governor is, why every heavy spawn must go through `spawnManaged`, why the governor is the only thing allowed to suspend a child, and what the ESLint rule is protecting — so the next contributor adding a local tool inherits the budget knowingly
- [X] T083 Run the full gate set: `npm run format:check`, `npm run lint`, `npm test`, plus `npm run build -w @video-compressor/agent` and `npm run build -w @video-compressor/web` (CI never builds the agent, so this gate is carried manually)
- [ ] T084 Walk [quickstart.md](./quickstart.md) sections 3–6 on macOS and record the measured numbers against SC-001, SC-002, SC-003, SC-006, SC-007, SC-009 and SC-010
- [ ] T085 Run the SC-005 trial from [quickstart.md](./quickstart.md) section 3a: with a limit in force and a job running, carry out ordinary work (browsing, editing, a video call) across several sessions and record whether system-wide slowdown was perceived
- [ ] T086 Walk [quickstart.md](./quickstart.md) section 7 on Windows, including the kill-the-agent-mid-job check for orphaned suspended processes — the most consequential failure mode in the design
- [ ] T087 Walk [quickstart.md](./quickstart.md) section 8 edge cases and section 9 time-to-task, and tick the Definition of Done

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: no dependencies — start immediately
- **Phase 2 (Foundational)**: needs Phase 1 — **blocks every user story**
- **Phase 3 (US1)**: needs Phase 2
- **Phase 4 (US2)**: needs Phase 2. Independent of US1 — the sampler does not care whether throttling exists
- **Phase 5 (US3)**: needs Phase 2. Touches US1's POST handler (T067) and context store (T068), so if run in parallel with US1 it should land after T040 and T046
- **Phase 6 (US4)**: needs Phase 2, the duty cycler (T034) and the sampler (T055), since it supplies both their Windows implementations
- **Phase 7 (Polish)**: needs every story intended for the release

### Story dependencies

- **US1 (P1)** — no dependency on other stories. Ships as the MVP on its own
- **US2 (P1)** — no dependency on US1; the readout works whether or not a limit is set
- **US3 (P2)** — soft dependency on US1's route handler and context store
- **US4 (P2)** — genuine dependency on US1's cycler (T034) and US2's sampler (T055). It is the platform-parity qualifier, so it cannot precede what it makes portable

### Critical ordering inside US1

T033 (hold protocol) → T034 (duty cycler) → T035 (queue migration) must land **together, in that order**. Shipping T034 without T035 leaves two independent suspenders fighting over the same process and silently breaks estimate prioritization; shipping T034 without T036 turns throttling into random `RENDER_TIMEOUT` failures. These three are one atomic change, not three independent ones.

### Within a story

- Tests are written first and must fail before the implementation lands
- Governor internals before routes; routes before web client; web client before components
- i18n keys and styling can land in parallel with the component that uses them

### Parallel opportunities

- **Phase 1**: T001, T002, T003, T005 in parallel (T004 and T006 follow)
- **Phase 2**: the eight migration tasks T014–T021 are one file each and fully parallel once T008 exists; T023 and T024 in parallel. T022 must come **after** all of them
- **Phase 3**: the seven test tasks T025–T031 in parallel; then T041, T047, T048, T049 in parallel with the agent-side work. T033/T034/T035/T036 are sequential as noted above
- **Phase 4**: T050–T053 in parallel; T060, T061, T062 in parallel
- **Cross-story**: once Phase 2 lands, US1 and US2 can be built by different people with no shared file except `apps/web/src/lib/power.tsx` and `apps/web/src/i18n.ts`

---

## Parallel Example: Phase 2 spawn-site migration

```bash
# After T008 (spawnManaged) exists — one file each, no shared state:
Task: "Migrate apps/agent/src/ffmpeg/encoder.ts to spawnManaged"
Task: "Migrate apps/agent/src/whisper/transcriber.ts to spawnManaged"
Task: "Migrate apps/agent/src/transcription/media-preview.ts to spawnManaged"
Task: "Migrate apps/agent/src/media-actions/image-converter.ts to spawnManaged"
Task: "Migrate apps/agent/src/landing/{workspace,images}.ts to spawnManaged"
Task: "Migrate apps/agent/src/translation/{translator,aligner}.ts to spawnManaged"
Task: "Migrate apps/agent/src/estimate/worker.ts and images/static-edges.ts to spawnManaged"
Task: "Register the Playwright browser tree from apps/agent/src/landing-preview/catalog.ts"
```

## Parallel Example: User Story 1 tests

```bash
Task: "Budget math, low-core floor, and unrestricted-is-unchanged in tests/power-governor.test.ts"
Task: "Duty-cycler windows under fake timers in tests/power-governor.test.ts"
Task: "Safety invariants (resume-on-shutdown, deregistration, recycled PIDs) in tests/power-governor.test.ts"
Task: "Hold protocol and graceful cancel while suspended in tests/power-queue-integration.test.ts"
Task: "Wall-clock budget scaling in tests/power-timeout-scaling.test.ts"
Task: "Scope boundary (transfers and HTTP stay unthrottled) in tests/power-scope.test.ts"
Task: "POST /api/power/limit rows in tests/power-routes.test.ts"
```

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Phase 1 → Phase 2 → Phase 3
2. **Stop and validate**: [quickstart.md](./quickstart.md) sections 3, 3a, 3b and 4 on macOS
3. This alone delivers the user's stated goal — leave Soty running without it taking the machine

Note the honest limit of that MVP: no live readout, no persistence across restarts, and no throttling on Windows. Each is a later phase, not a rough edge to paper over in the release note.

### Incremental delivery

1. Setup + Foundational → the agent knows what it owns
2. **+ US1** → the lever works (MVP, macOS)
3. **+ US2** → the user can see what Soty is doing
4. **+ US3** → the setting survives restarts and is visible at a glance
5. **+ US4** → Windows reaches parity, and the existing Windows pause debt is repaid

### Parallel team strategy

Phase 2 is the bottleneck and is worth staffing wide — T014–T021 are eight independent one-file migrations. Once it lands: one person on US1 (agent throttling + lever), one on US2 (sampler + readout), and US3 folded into whoever finishes first. US4 should start only after T034 and T055 exist, since it supplies their Windows implementations.

---

## Notes

- `[P]` means a different file and no dependency on incomplete work
- Every test task names the invariant or contract-matrix row it proves — see [data-model.md](./data-model.md#invariants) and [contracts/agent-http.md](./contracts/agent-http.md#route-level-test-matrix)
- Do not use the `if (!available) return;` pattern in real-binary tests — it reports as PASSING when a tool is absent. Use `it.skipIf` / `ctx.skip()` so a skipped test looks skipped
- Commit after each task or coherent group; stop at any checkpoint to validate a story on its own
- **The three riskiest tasks are T034, T035 and T074.** A bug in T034 or T074 leaves a user's process suspended forever; skipping T035 breaks a feature that works today without any test noticing. [Invariants 1, 10 and 11](./data-model.md#invariants) and quickstart sections 3b and 7.3 exist specifically to catch these
