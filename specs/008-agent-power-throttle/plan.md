# Implementation Plan: Local Agent Power Throttle

**Branch**: `008-agent-power-throttle` | **Date**: 2026-08-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-agent-power-throttle/spec.md`

## Summary

One machine-wide ceiling on everything Soty runs locally, plus a live readout of what Soty is actually consuming, driven from a thrust-lever control in the app header.

The technical approach is a new agent-side **Power Governor**: a single server-wide facility that owns the limit, derives a CPU budget from it, hands that budget to every tool that spawns a heavy child process, and actively duty-cycles the running process tree to hold the ceiling in real time. Every heavy spawn goes through one managed wrapper, so the budget is genuinely shared across compressor, landing optimizer, landing preview, transcription, media actions, and team-workspace processing — and so any tool added later is inside the ceiling by construction rather than by remembering to opt in.

Live consumption is measured by sampling cumulative CPU time of the agent plus its registered process tree and converting the delta into a share of total system capacity. Sampling runs only while a client is watching, and is pushed over a dedicated SSE channel — the same subscribe-and-reconnect path every other live surface in the web app already uses.

The hard problems, resolved in [research.md](./research.md):

1. **Holding a ceiling on already-running work** when neither macOS nor Windows offers a userland CPU quota — solved by duty-cycling the process tree ([R2](./research.md#r2--holding-a-ceiling-on-already-running-work)).
2. **Doing that on Windows**, which has no `SIGSTOP` — solved by a long-lived PowerShell helper doing `NtSuspendProcess`/`NtResumeProcess`, extending the existing `platform.ts` `processPause` capability to win32 instead of leaving the feature macOS-only ([R3](./research.md#r3--suspending-a-process-on-windows)).
3. **Not breaking what already suspends processes.** The compressor queue already stops the active encode so estimates can jump the line. A second, independent suspender would fight it, and `SIGTERM` does not reach a stopped process at all. The governor therefore becomes the sole owner of suspend state, with a hold/release protocol for other subsystems ([R11](./research.md#r11--one-owner-of-suspend-state)).
4. **Not turning a slowdown into a failure.** Landing preview, the team render bridge, and the queue's kill escalation all enforce *wall-clock* deadlines. Stretch wall-clock time five-fold and those deadlines fire, so throttling would manufacture `RENDER_TIMEOUT` errors. Every managed-work budget scales with the duty cycle ([R12](./research.md#r12--wall-clock-timeouts-under-a-duty-cycle)).
5. **Keeping the default indistinguishable from today.** At 100% the agent passes no thread flags and makes no priority call, so users who never open the panel see byte-identical behaviour ([R13](./research.md#r13--unrestricted-must-mean-exactly-as-today)).

## Technical Context

**Language/Version**: TypeScript 5.x, `strict: true`, ESM `NodeNext`, target ES2022, Node 22 runtime

**Primary Dependencies**: Fastify 5 (agent HTTP), React 19 + Vite (web), `@video-compressor/shared` (contract). **No new runtime dependency** — the Windows suspend helper uses `powershell.exe`, already the established Windows mechanism in `apps/agent/src/files/picker.ts`

**Storage**: New `power.json` in the application-support root, written atomically (temp + `rename`), mirroring the existing `queue/store.ts` pattern. `AGENT_POWER_STATE_PATH` env override for tests, mirroring `AGENT_STATE_PATH`

**Testing**: Vitest, all specs in the central `tests/` directory; jsdom via `// @vitest-environment jsdom` docblock for the panel; `vi.useFakeTimers` for the duty cycler; `mkdtemp` + `afterEach` cleanup for persistence

**Target Platform**: macOS (arm64/x64) and Windows (x64) desktop, agent as a local Node process on `127.0.0.1:43120`

**Project Type**: npm-workspaces monorepo — local agent + web SPA + shared contract package

**Performance Goals**: limit change visible on running work within 5 s (FR-009); consumption sample refresh ≤ 2 s (FR-016); sampler + duty cycler together ≤ 1% of system CPU (SC-010); measured share within limit + 10 pp over any 30 s window (SC-001)

**Constraints**: no native addon, no new npm dependency; must not cancel, restart, or alter in-flight work (FR-010); must never let throughput reach zero at the minimum limit (FR-013); Windows and macOS within 15 pp of each other (SC-008); at 100% the spawned argv must be byte-identical to today's (FR-011)

**Scale/Scope**: 1 new agent module (`power/`), 1 platform-layer extension, ~8 heavy spawn sites migrated to the managed wrapper, 1 existing suspend call site migrated to the hold protocol, ~5 wall-clock deadlines scaled, 2 new HTTP routes + 1 SSE channel, 1 new tool contract, 1 web context store + 3 components, ~14 i18n key pairs, 12 new test files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — see [Post-Design Re-check](#post-design-re-check).*

| Principle | How this design complies |
|---|---|
| **I. Type-Safe Contracts, Validated at the Boundary** | `PowerState`, `PowerSample`, `PowerLimitRequest` live in `@video-compressor/shared` with `POWER_LIMIT_MIN`/`POWER_LIMIT_MAX`/`DEFAULT_POWER_LIMIT` and a `clampPowerLimit()` helper — the canonical bounds, never re-derived inline. The `POST` body is typed `unknown` and narrowed by an explicit `parsePowerLimitRequest(): { ok: true; value } \| { ok: false; error }` guard. Persisted `power.json` is untrusted on read and goes through the same parse. Sampler output from `ps`/PowerShell is parsed, never cast. Governor state is a string-literal union (`'unrestricted' \| 'limited'`) and sampler availability a discriminated union so no branch can be silently skipped. |
| **II. One Source of Truth for the Release & Protocol Contract** | Adds `power: 1` to `AGENT_TOOL_CONTRACTS` and `power: { power: 1 }` to `WEB_TOOL_REQUIREMENTS` in `packages/shared/src/release.ts`. The web gates the control on the existing `toolContractCompatible()` check, which is exactly how FR-022 ("agent too old") is satisfied — no ad-hoc version sniffing. `AGENT_API_VERSION` is **not** bumped: additive routes behind a new tool contract are what the contract map exists for. `shared` is rebuilt before any gate runs. |
| **III. Security and Least Privilege by Construction** | New routes sit behind the existing origin allowlist, session-token check, and entitlement gate — **not** added to `ENTITLEMENT_EXEMPT_ROUTES`. The SSE channel reuses `EventChannel` with its per-client write guard. No shell strings anywhere: the PowerShell helper is spawned `shell: false` with a fixed argv, and receives only integer PIDs on stdin — PIDs are validated as integers before being written, so nothing user-controlled reaches it. No new secret, no new file outside the application-support root. |
| **IV. Disciplined Child-Process & Resource Orchestration** | The managed spawn wrapper is the centrepiece: `spawn(cmd, args, { shell: false })`, a promise that resolves a result object and never rejects on non-zero exit, bounded stderr, tracked child reference for cancellation. The PowerShell helper is a long-lived child with SIGTERM→SIGKILL escalation on shutdown and `.unref()`'d timers. `power.json` writes are temp + `rename`. The governor guarantees `finally`-style deregistration so a crashed child cannot leak a suspended process — and every suspended PID is resumed on shutdown, before the process exits. |
| **V. Consistent HTTP API & Error Conventions** | `GET /api/power` and `POST /api/power/limit` both return the `PowerState` snapshot; errors return `reply.code(N).send({ error })` with stable machine codes (`POWER_LIMIT_INVALID`, `POWER_UNAVAILABLE`). Status codes follow the existing table: 400 invalid body, 401 token, 403 origin/entitlement. Background sampler failures funnel through the single `logError` sink. |
| **VI. Frontend Composition & State Discipline** | `PowerContext` follows the house idiom exactly: `createContext<T \| null>(null)`, a `usePower()` hook that throws outside its provider, and a `PowerContextOverride` for tests. Live state arrives over `useAgentEventStream`, not polling. All calls go through the typed `request`/`requestBody` wrappers in `api/client.ts`. All copy is a compile-checked `TranslationKey` via `useI18n()`. Styling is `className` against `styles.css` with CSS custom properties; inline `style` is reserved for the one computed value the lever needs (its travel offset). Telemetry via `analytics.track` with a constrained event name. New components are small and single-purpose — explicitly not another 1,000-line file. |

**Gate result before Phase 0: PASS.** No violations, so the Complexity Tracking table stays empty.

**One spec/reality tension surfaced by research, resolved rather than waived:** FR-014 and SC-008 demand equivalent behaviour on Windows and macOS, but `platform.ts` currently reports `processPause: false` on win32 (no `SIGSTOP`), which would make live throttling of running work macOS-only. Rather than ship an asymmetric feature or weaken the requirement, the plan extends the platform layer so win32 gains a real suspend/resume implementation ([research.md R3](./research.md#r3--suspending-a-process-on-windows)). This also repays an existing debt: the compressor's "pause during estimates" path is a silent no-op on Windows today.

## Project Structure

### Documentation (this feature)

```text
specs/008-agent-power-throttle/
├── plan.md              # This file
├── research.md          # Phase 0 output — mechanism decisions
├── data-model.md        # Phase 1 output — entities, state, transitions
├── quickstart.md        # Phase 1 output — how to validate it works
├── contracts/           # Phase 1 output
│   ├── agent-http.md    # Routes, payloads, status codes, SSE frames
│   ├── shared-types.md  # Types/constants added to @video-compressor/shared
│   └── ui-contract.md   # Header control, panel, lever a11y, readout states
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /speckit-specify)
├── spec.md
└── tasks.md             # Phase 2 output — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
packages/shared/src/
├── types.ts                      # + PowerState, PowerSample, PowerEvent,
│                                 #   POWER_LIMIT_MIN/MAX, DEFAULT_POWER_LIMIT,
│                                 #   clampPowerLimit(), parsePowerLimitRequest()
└── release.ts                    # + AGENT_TOOL_CONTRACTS.power,
                                  #   WEB_TOOL_REQUIREMENTS.power

apps/agent/src/
├── power/
│   ├── governor.ts               # NEW — owns the limit, the CPU budget, the
│   │                             #   registry of managed children, the duty cycler
│   ├── store.ts                  # NEW — power.json load/save (atomic)
│   ├── sampler.ts                # NEW — CPU-time sampling → PowerSample
│   ├── process-tree.ts           # NEW — PID → descendant PIDs, per platform
│   ├── spawn.ts                  # NEW — spawnManaged(): the single heavy-spawn seam
│   └── routes.ts                 # NEW — GET /api/power, POST /api/power/limit,
│                                 #   GET /api/power/events
├── platform/
│   ├── platform.ts               # processPause: true on win32; suspend/resume now
│   │                             #   route through the helper; + cpuTimeProbe hooks
│   └── windows-suspend.ts        # NEW — long-lived PowerShell suspend/resume helper
├── server/
│   ├── app.ts                    # registerPowerRoutes(); ToolContext gains `power`
│   └── tools.ts                  # ToolContext + `power: PowerGovernor`
├── ffmpeg/
│   ├── presets.ts                # -threads / -filter_threads ONLY when limited
│   └── encoder.ts                # spawn → spawnManaged
├── whisper/transcriber.ts        # threads option fed by the budget; spawnManaged
├── transcription/media-preview.ts  # spawnManaged — a full ffmpeg run despite the name
├── landing/{workspace,images}.ts # spawnManaged
├── landing-preview/
│   ├── catalog.ts                # registers the Playwright browser tree
│   ├── renderer.ts               # RENDER/NAVIGATION timeouts via scaleTimeout()
│   └── scanner.ts                # FS_OP_TIMEOUT_MS via scaleTimeout()
├── media-actions/image-converter.ts  # spawnManaged
├── translation/{translator,aligner}.ts  # spawnManaged
├── estimate/worker.ts            # spawnManaged
├── images/static-edges.ts        # spawnManaged
├── team-bridge/landing-gallery.ts  # RENDER_TIMEOUT watchdog via scaleTimeout()
├── queue/queue.ts                # estimate pause → governor.hold(); cancel/shutdown
│                                 #   → governor.resumeForTermination() before SIGTERM
└── index.ts                      # governor construction + shutdown chain entry

apps/web/src/
├── lib/power.tsx                 # NEW — PowerProvider, usePower, PowerContextOverride
├── components/
│   ├── PowerThrottle.tsx         # NEW — header button + popover shell
│   ├── PowerLever.tsx            # NEW — vertical thrust lever (role="slider")
│   └── PowerReadout.tsx          # NEW — live consumption text + states
├── api/client.ts                 # + fetchPowerState, setPowerLimit, powerEventsUrl
├── analytics/events.ts           # + power_panel_opened, power_limit_changed
├── App.tsx                       # mount <PowerThrottle /> beside <ThemeToggle />
├── i18n.ts                       # + en/uk keys
└── styles.css                    # + .power-* rules

eslint.config.mjs                 # + @typescript-eslint/no-restricted-imports:
                                  #   node:child_process off-limits under
                                  #   apps/agent/src outside platform/, power/ and
                                  #   the four probe/dialog files that legitimately
                                  #   spawn unmanaged; allowTypeImports: true so the
                                  #   type-only import in queue/queue.ts still works.
                                  #   This is what makes FR-008 ("future tools
                                  #   covered by default") structural, not aspirational

tests/
├── power-contract.test.ts        # clamp table + both parse guards
├── power-governor.test.ts        # budget math, duty cycle, holds, safety invariants
├── power-routes.test.ts          # HTTP contract on a really-assembled server
├── power-persistence.test.ts     # power.json round-trip, corruption, atomicity
├── power-sampler.test.ts         # sample math, unavailable states
├── power-process-tree.test.ts    # descendant walk per platform (mocked probe)
├── power-spawn-coverage.test.ts  # every heavy spawn managed; no stray suspend calls
├── power-queue-integration.test.ts  # estimate hold + graceful cancel while suspended
├── power-timeout-scaling.test.ts # wall-clock budgets scale with the duty cycle
├── power-scope.test.ts           # transfers and HTTP stay outside the budget
├── power-windows-suspend.test.ts # helper protocol, PID validation, crash recovery
└── power-panel.test.tsx          # jsdom: lever a11y, keyboard, readout states
```

**Structure Decision**: The feature follows the existing monorepo seams exactly — a new self-contained agent module under `apps/agent/src/power/`, OS-specific mechanism confined to `apps/agent/src/platform/`, contract types in `packages/shared/src/`, and small single-purpose components under `apps/web/src/components/` fed by one context store in `apps/web/src/lib/`. No new package, no new build step, no new dependency.

The one structural addition worth calling out is `power/spawn.ts`. It exists because "one shared budget across all tools" (FR-007) and "future tools covered by default" (FR-008) cannot be satisfied by a convention that each tool must remember; there has to be a single seam every heavy child process passes through. Pairing it with the ESLint import restriction makes the seam enforced the same way `platform.ts` already enforces portability — which is the precedent the constitution set.

**Governor placement**: `PowerGovernor` is deliberately **not** a `ToolModule`. It is server-wide infrastructure that tools consume, which is precisely what `ToolContext` is documented to carry ("server-wide facilities every tool module may rely on"). So `ToolContext` gains `power: PowerGovernor`, its routes are registered in `app.ts` next to health, and its shutdown joins the existing chain in `index.ts`. Modelling it as a fake tool with `busy: () => false` would have misrepresented it in the `/health` busy flag.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.

## Phase Status

- [x] Phase 0 — research complete → [research.md](./research.md)
- [x] Phase 1 — design complete → [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)
- [x] Phase 2 — tasks → [tasks.md](./tasks.md)
- [x] Cross-artifact analysis → remediated; see [Analysis remediation](#analysis-remediation)

## Analysis Remediation

`/speckit-analyze` found two CRITICAL and three HIGH issues after the first design pass. All are resolved in the artifacts above; recorded here so the reasoning is not lost:

| Was | Now |
|---|---|
| The duty cycler suspended children independently of the compressor queue's existing estimate pause — two owners of one process's stopped state, silently breaking estimate prioritization, and `SIGTERM` sent to a stopped process | Governor is the sole owner, with a hold/release protocol and `resumeForTermination()` ([R11](./research.md#r11--one-owner-of-suspend-state), [invariants 10–11](./data-model.md#invariants), T033/T034/T035) |
| Wall-clock deadlines (`RENDER_TIMEOUT_MS`, `NAVIGATION_TIMEOUT_MS`, the 2 s kill escalation) unchanged under throttling, so a 20% limit would manufacture `RENDER_TIMEOUT` failures | `scaleTimeout()` divides every managed-work budget by `dutyOnFraction` ([R12](./research.md#r12--wall-clock-timeouts-under-a-duty-cycle), [invariant 13](./data-model.md#invariants), T036) |
| `transcription/media-preview.ts` — a full ffmpeg transcode — missing from the spawn-site migration list | Migrated (T016) |
| The ESLint allowlist covered only `platform/` and `power/`, which would have failed `npm run lint` on four probe/dialog files and on a type-only import | Explicit file allowlist plus `allowTypeImports: true` ([R6](./research.md#r6--making-the-budget-genuinely-shared-and-automatic-for-future-tools), T022) |
| At 100% the budget still emitted thread arguments — whisper would jump 8 → 10 threads and FFmpeg would gain a `-threads` flag it has never had | Unrestricted yields `null` budget values; argv byte-identical to today ([R13](./research.md#r13--unrestricted-must-mean-exactly-as-today), [invariant 12](./data-model.md#invariants), T032/T037/T038) |
| FR-020 (limit governs local processing only) and SC-005 (no perceived slowdown) had zero coverage; FR-021 covered display but not behaviour; FR-023 had no automated test | T030 + quickstart §4a, T085 + quickstart §3a, T068, T053 |

## Post-Design Re-check

Re-evaluated after Phase 1 produced the concrete types, routes, and UI contract:

- **Principle I** — every new boundary now has a named guard in [contracts/shared-types.md](./contracts/shared-types.md): request body, persisted file, `ps`/PowerShell output. No `as` casts in the design. **PASS**
- **Principle II** — the design bumps no version and adds exactly one contract entry; `verify-release.mjs` remains the gate and needs no change. **PASS**
- **Principle III** — the routes are entitlement-gated; the PowerShell helper receives only validated integers. One deliberate call recorded in [research.md R7](./research.md#r7--entitlement-gating-and-the-degraded-ui-state): the header control is visible pre-entitlement but reports "unavailable" rather than the route being opened up. **PASS**
- **Principle IV** — the design adds a new class of long-lived child (the Windows helper) and three failure modes around suspension: a process left suspended, two subsystems fighting over one process's stopped state, and `SIGTERM` delivered to a stopped process. All three are addressed explicitly — helper lifecycle mirrors the existing watchdog escalation; the governor is the sole writer of suspend state with a hold/release protocol; and every cancel path resumes before terminating. Stated as [invariants 1, 2, 10 and 11](./data-model.md#invariants), each with a named test. **PASS, after remediation** — the first design pass had the duty cycler suspending independently of the queue's existing estimate pause, which would have silently broken estimate prioritization; [research R11](./research.md#r11--one-owner-of-suspend-state) records the correction.
- **Principle V** — snapshot-returning routes, machine-code errors, existing status-code table. **PASS**
- **Principle VI** — context idiom, SSE not polling, typed client wrappers, compile-checked i18n, three small components instead of one large one. **PASS**

**Gate result after Phase 1: PASS.** Complexity Tracking remains empty.
