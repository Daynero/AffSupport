# Phase 0 Research: Local Agent Power Throttle

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-08-20

The Technical Context in the plan carries no `NEEDS CLARIFICATION` markers because the questions this feature raises are not "which library" questions — they are "does this mechanism exist on this OS at all" questions. Those are resolved below.

Codebase facts each decision was checked against are cited by path, so a reviewer can verify the premise rather than the conclusion.

---

## R1 — What "resource limit" can actually mean here

**Decision**: The limit governs **CPU**, expressed as a share of total system capacity (all cores). Memory, disk I/O, GPU, and network are out of scope.

**Rationale**: The user's goal is "leave Soty running in the background without it taking the whole computer and getting in the way of parallel work." For this workload that is a CPU problem: the agent's heavy children are FFmpeg (`apps/agent/src/ffmpeg/encoder.ts`), whisper.cpp (`apps/agent/src/whisper/transcriber.ts`), and headless Chromium for landing preview — all CPU-saturating, none memory- or IO-bound in a way a user perceives as "my machine is slow." Capping CPU delivers the felt outcome; capping memory would not.

**Alternatives considered**:
- *Composite "resource" score across CPU/RAM/IO* — unmeasurable as a single percentage, and impossible to state a testable success criterion for. Rejected.
- *GPU inclusion* — hardware encoders are not currently used by the encode path, and no cross-platform userland GPU quota exists. Rejected as out of scope, not as impossible forever.

---

## R2 — Holding a ceiling on **already-running** work

This is the hardest requirement: FR-009 says a limit change must reach work that is already in flight, within 5 seconds, without cancelling or restarting it (FR-010).

**Decision**: **Duty-cycle the managed process tree** — suspend and resume it on a fixed period, with the on-fraction equal to the limit. A 200 ms period at a 40% limit means 80 ms running, 120 ms suspended. Combined with two spawn-time measures (thread budget and reduced process priority) that make the steady state land close to target before the cycler has to do much work.

**Rationale**:
- Neither macOS nor Windows exposes a userland CPU quota to an unprivileged process. macOS has no cgroups; Windows Job Object CPU rate control requires native code. Duty cycling is the only mechanism that (a) works on a process that is already running, (b) needs no privileges, and (c) is inherently continuous — you change the on-fraction and the effect is immediate.
- It is the mechanism `cpulimit` has used on POSIX for two decades; the behaviour and its failure modes are well understood.
- The codebase **already does this**: `pauseProcess`/`resumeProcess` in `apps/agent/src/platform/platform.ts:274-291` wrap `SIGSTOP`/`SIGCONT`, and `apps/agent/src/queue/queue.ts:1170-1199` already suspends the active encode while estimates run. This feature generalises an existing, proven mechanism rather than introducing a new one.
- A 200 ms period is short enough that FFmpeg's output pipe never stalls long enough to matter and progress reporting stays smooth, and long enough that the scheduler overhead is negligible (two signals per 200 ms per tracked PID).

**Alternatives considered**:
- *Thread count alone* (`-threads N` for FFmpeg, `-t N` for whisper) — correct and free for **new** work, but the argument vector is fixed at spawn. It cannot satisfy FR-009 for running work. Kept as a complementary spawn-time measure, rejected as the sole mechanism.
- *Process priority alone* (`os.setPriority`) — makes Soty yield to foreground apps, which serves the "don't get in the way" half of the goal, but it does **not** cap consumption: on an otherwise idle machine a niced FFmpeg still takes 100%. It also has an asymmetry that rules it out as the live control: on POSIX an unprivileged process can raise its nice value but **cannot lower it back**, so raising the limit again would be impossible without a restart. Kept as a spawn-time measure only.
- *Cancel and re-spawn with new thread arguments* — directly violates FR-010. Rejected.
- *Native addon exposing Job Objects / `setrlimit`* — see [R3](#r3--suspending-a-process-on-windows) and [R4](#r4--why-not-a-native-addon).

**Consequence to design for**: a suspended process is invisible to nothing and dangerous to everything — if the agent dies mid-cycle, the child stays stopped forever. The governor must resume every tracked PID on shutdown, on child exit, and on any error path. This is recorded as an invariant in [data-model.md](./data-model.md#invariants) with a named test.

---

## R3 — Suspending a process on **Windows**

**Decision**: A **long-lived PowerShell helper process** that P/Invokes `NtSuspendProcess` / `NtResumeProcess`, reading PID commands from stdin. `platform.ts` `capabilities().processPause` becomes `true` on win32, backed by this helper.

**Rationale**:
- Windows genuinely has no `SIGSTOP`; `child.kill('SIGSTOP')` is a no-op there, which is exactly why `capabilities()` in `apps/agent/src/platform/platform.ts:51-58` reports `processPause: false` for win32 today. Without solving this, the entire live-throttle half of the feature is macOS-only, breaking FR-014 and SC-008.
- PowerShell is **already** the established Windows mechanism in this codebase — `runWindowsPicker` in `apps/agent/src/files/picker.ts:157-182` spawns `powershell.exe` with `shell: false`, a fixed argv, and `windowsHide: true`. This adds no new class of dependency, no new packaging artifact, and nothing to sign.
- Keeping the helper **long-lived** is what makes it viable: PowerShell start-up is ~200 ms, far too slow to pay per suspend at 5 Hz, but once the runspace is warm a stdin command round-trips in about a millisecond. One warm helper serves every tracked PID.
- It is spawned lazily — only when the limit is below 100% on Windows — so users who never throttle never pay for it.
- Security-wise the helper receives only integers. PIDs are validated as positive integers before being written to stdin, so nothing user-influenced reaches the shell. The helper script itself is a compile-time constant in the source, never assembled from input.

**Alternatives considered**:
- *`ntsuspend` npm native addon* — smallest code, but it is a native `.node` binary needing per-arch prebuilds threaded through the Windows packaging pipeline. Disproportionate for two syscalls. Rejected for v1.
- *Job Object CPU rate control* (`JOBOBJECT_CPU_RATE_CONTROL_INFORMATION`) — technically the **best** answer on Windows: a real kernel-enforced percentage cap, no duty-cycle jitter, no risk of a stuck-suspended process. It requires native code, and it has no macOS counterpart, so adopting it would mean maintaining two entirely different throttling models. Recorded as the preferred long-term upgrade for Windows once a native layer exists for other reasons; rejected for v1.
- *Spawn a fresh PowerShell per suspend/resume* — ~200 ms and a process spawn per 100 ms of duty cycle. Absurd. Rejected.
- *Ship the feature macOS-only, degrade Windows to next-job-only* — would break FR-014/SC-008 and leave the existing Windows `pauseProcess` gap unrepaid. Rejected.

**Bonus**: implementing this repays an existing debt. The compressor's "suspend the encode while estimates run" path (`queue.ts:1170`) silently does nothing on Windows today; once `processPause` is real there, that behaviour starts working too. The Windows suspend work should therefore be validated against **both** call sites, not just the new one.

---

## R4 — Why not a native addon

**Decision**: No native module, no new npm dependency, for v1.

**Rationale**: `apps/agent/package.json` currently has no native compilation step at all — every dependency is pure JS or a prebuilt browser bundle. Introducing the first `.node` binary means per-platform prebuilds, an install-time build fallback, and a new failure mode in the Windows packaging pipeline that landed only one commit ago (`16176f1 feat: build the Windows release pipeline…`). The PowerShell-helper route reaches the same functional outcome with mechanisms the repo already ships and already knows how to package.

This is a v1 boundary, not a permanent rule. [R3](#r3--suspending-a-process-on-windows) records Job Objects as the right destination when a native layer becomes justified for other reasons.

---

## R5 — Measuring what Soty is consuming

**Decision**: Sample **cumulative CPU time** for the agent process and every registered descendant, once per second while a client is watching, and convert consecutive samples into a share of system capacity:

```
share% = (Δcpu_time_seconds / (Δwall_seconds × os.cpus().length)) × 100
```

Self-usage comes free from `process.cpuUsage()`. Child usage comes from one batched platform probe per tick: `ps -o pid=,time= -p <pids>` on macOS, and a `Get-Process` line on the same long-lived PowerShell helper on Windows.

**Rationale**:
- Deltas of cumulative CPU time give a true instantaneous rate. This matters because macOS `ps %cpu` is a **decaying lifetime average**, not an instantaneous figure — reading it directly would make the readout lag the lever by tens of seconds and make FR-016 and SC-002 unverifiable. This is the single most common way to get this measurement wrong.
- Batching every PID into one probe per tick keeps the cost at one cheap process spawn per second on macOS and zero extra spawns on Windows (the helper is already resident) — comfortably inside SC-010's 1% ceiling.
- The agent already knows every PID it cares about, because `spawnManaged` registers them. There is no need to scan the system process table for "processes that look like ours."
- Dividing by `os.cpus().length` expresses the result as a share of the whole machine, matching both the limit's meaning and the user's phrasing ("у відсотках від системи").

**Alternatives considered**:
- *`pidusage` npm package* — does exactly this, well tested. Rejected only because it is a new dependency for roughly forty lines of code we need to own anyway (the process-tree walk is required by the throttler regardless).
- *macOS `ps %cpu` / Windows `wmic`* — wrong semantics (see above) and `wmic` is deprecated and absent on current Windows builds. Rejected.
- *Sampling continuously regardless of viewers* — violates FR-019. Rejected; sampling is refcounted to SSE subscribers.

**Process-tree walk**: FFmpeg and whisper are leaves, but Playwright's Chromium spawns a renderer tree, so descendants must be included or the readout under-reports. macOS: one `ps -ax -o pid=,ppid=` walk. Windows: `Get-CimInstance Win32_Process` via the resident helper. Refreshed on a slower cadence than the sample tick (the tree changes rarely; recomputing it every second would be waste).

---

## R6 — Making the budget genuinely shared, and automatic for future tools

**Decision**: A single `spawnManaged()` seam in `apps/agent/src/power/spawn.ts` that every heavy child process goes through, plus an ESLint `no-restricted-imports` rule making `node:child_process` off-limits under `apps/agent/src` outside `platform/` and `power/`.

**Rationale**:
- FR-007 says the limit is one shared budget across all tools *simultaneously*, and FR-008 says a tool added later is covered *by default*. A per-tool convention cannot deliver either: there are already 20+ `spawn(` call sites across `apps/agent/src`, and the twenty-first will forget.
- The constitution set the precedent directly. `eslint.config.mjs:63-70` already restricts `process.platform`/`process.arch` to the platform module, with the reasoning "a tool is written once and must run on both platforms." The identical argument applies here: a tool is written once and must stay inside the budget.
- The seam is also where per-child priority is set and where registration/deregistration is guaranteed, so the "leaked suspended process" failure mode has exactly one place to be prevented.

**Scope of "heavy"**: only long-running, CPU-consuming children register — encode, transcribe, translate, align, render, convert, estimate, **and the transcription media-preview transcode** (`transcription/media-preview.ts:231`, a full ffmpeg run with progress reporting that is easy to overlook because its name suggests something lightweight). Instant probes and dialogs stay unmanaged; throttling a 30 ms dialog spawn would be pure overhead.

**The allowlist is not just `platform/`.** The unmanaged spawns do **not** all live in the platform module — checked against the tree, they are `ffmpeg/tools.ts:1` and `whisper/tools.ts:1` (`-version` / `--help` probes), `files/picker.ts` (native dialogs), and `files/dropped-source.ts:1` (`mdfind`). `queue/queue.ts:4` additionally carries a **type-only** import of `ChildProcessWithoutNullStreams`. So the rule must:

- allow `platform/`, `power/`, and that explicit file list, and
- use `@typescript-eslint/no-restricted-imports` with `allowTypeImports: true`, because the base ESLint rule flags type-only imports too and would otherwise break `queue.ts` for no reason.

A narrower rule fails `npm run lint`, which the constitution makes a mandatory pre-PR gate — the rule has to be right the first time or it blocks the branch.

**Alternatives considered**:
- *Per-tool concurrency settings* — the user explicitly asked for one control, not per-tool knobs. Also cannot cap two tools running at once. Rejected.
- *Register children by scanning for known executable names* — brittle, and silently misses any future tool. Rejected.
- *Convention plus code review* — the failure mode is silent and only shows up as "the limit doesn't work sometimes." Rejected in favour of the lint rule.

---

## R7 — Entitlement gating and the degraded UI state

**Decision**: `/api/power*` stays behind the entitlement gate — **not** added to `ENTITLEMENT_EXEMPT_ROUTES` (`apps/agent/src/server/app.ts:64`). The header control therefore renders in its "unavailable" state for an unpaired or unentitled session.

**Rationale**: Principle III says new surfaces inherit the existing posture rather than open a hole beside it. The exempt set today is exactly health, diagnostics, and entitlement — the routes needed to *establish* a session. A settings control is not in that category. The UX cost is small and already specified: FR-021 and FR-022 require a clear "no agent connected" / "agent too old" state anyway, so the degraded state is a state the design must build regardless.

**Alternatives considered**:
- *Exempt the GET so the readout works pre-entitlement* — leaks live machine-load telemetry to any allowed origin before entitlement is proven, for a cosmetic gain. Rejected.

---

## R8 — Where the setting lives, and why it is per-machine

**Decision**: A dedicated `power.json` in the application-support root, written atomically (temp + `rename`), owned by the agent. Not in the account, not in `localStorage`, not in `state.json`.

**Rationale**:
- **Per-machine, not per-account** (FR-012) because the value describes *this computer's* capacity. Syncing "20%" from a laptop to a workstation would be actively wrong.
- **Agent-owned, not browser-owned**, because the agent is the thing that must honour it — including for work already running when no browser tab is open. Storing it in `localStorage` would mean the limit vanishes whenever the UI is closed, and would make cross-window agreement (FR-023) a browser problem instead of falling out of the SSE broadcast for free.
- **Separate file, not `state.json`**, because `state.json` (`apps/agent/src/queue/store.ts`) is the compressor queue's persisted jobs and settings. Mixing a server-wide facility into one tool's store would couple their schemas and their corruption blast radius.
- `AGENT_POWER_STATE_PATH` mirrors the existing `AGENT_STATE_PATH` override so tests can point at a `mkdtemp` directory.

**Corruption behaviour**: an unparseable or out-of-range `power.json` falls back to the default (100%, unrestricted) and logs once. Never inherit a nonsense limit — the safe failure direction is "Soty runs at full speed," not "Soty is mysteriously stuck at 3%."

---

## R9 — Contract versioning strategy

**Decision**: Add `power: 1` to `AGENT_TOOL_CONTRACTS` and `power: { power: 1 }` to `WEB_TOOL_REQUIREMENTS` in `packages/shared/src/release.ts`. Do **not** bump `AGENT_API_VERSION` (currently 5, with MIN and MAX both 5).

**Rationale**: `release.ts:70-75` states the intent explicitly — versions identify binaries, contracts identify whether a local tool can serve a web client. This feature adds routes without changing any existing request or response, which is precisely the additive case the contract map exists for. Bumping `AGENT_API_VERSION` would force every older agent into "update required" for a feature they simply do not have, which is both hostile and wrong.

The payoff is that FR-022 ("agent too old to honour the limit") needs no new code path: the web already computes `toolContractCompatible()` against the `toolContracts` map in the health payload, so an older agent naturally reports the power control as unsupported.

---

## R10 — Keeping throughput non-zero at the floor

**Decision**: The thread budget is `max(1, round(limit/100 × cpuCount))`, and the duty cycler's on-window has a hard floor (≥ 50 ms per 200 ms period is never reduced below one scheduling quantum's worth of real progress).

**Rationale**: FR-013 requires that the minimum setting still completes work. On a 4-core machine a 20% limit yields `round(0.8) = 1` thread — the floor is doing real work there, and without it the budget would round to zero and the job would never finish. The duty-cycle floor guards the same failure from the other direction: an on-window shorter than the OS scheduling quantum yields a process that is technically resumed but never actually scheduled.

**Consequence**: on a low-core machine, the *effective* floor is higher than the nominal 20% — one thread of eight-core capacity is ~12.5%, but one thread of two-core capacity is 50%. This is honest and unavoidable; the spec's SC-001 tolerance is stated as "limit **plus** 10 pp", so overshoot on small machines is within the criterion as written, and the quickstart calls it out as an expected observation rather than a defect.

---

## R11 — One owner of suspend state

**Decision**: The governor is the **sole** owner of process suspension. The compressor queue's existing estimate-prioritization pause stops calling `pauseProcess`/`resumeProcess` directly and instead asks the governor for a **hold**: `governor.hold(child, reason)` returns a release handle. While any hold is outstanding the duty cycler leaves that child suspended and does not resume it.

**Rationale**: Without this, the feature silently breaks an existing one. `apps/agent/src/queue/queue.ts:1170-1199` already suspends the active encode so prioritized estimates get the machine. Add a duty cycler that independently suspends and resumes the *same* child, and the cycler's next on-window sends `SIGCONT` to a process the queue deliberately stopped — estimates lose their priority, and nothing anywhere reports a problem. Two independent owners of one process's stopped state cannot be made correct by ordering; there has to be one authority.

Two further hazards make this non-optional rather than tidy-up:

- **`SIGTERM` does not reach a stopped process.** A suspended process does not run its signal handlers until it is resumed, so cancelling a duty-suspended encode leaves FFmpeg unable to finalize its output; the escalation at `queue.ts:684-690` then falls through to `SIGKILL` after 2 s and the partial file is abandoned. The existing code proves the author already knew this — `queue.ts:683` resumes the child *before* `SIGTERM` precisely for this reason, but it only knows about `compressionPausedForEstimates`. The governor must expose "resume and stay resumed" and every cancel/shutdown path must call it.
- **PID recycling.** Two owners each tracking their own suspend bookkeeping can disagree about whether a child is stopped, and a resume aimed at a stale PID lands on whatever the OS reused it for.

**Alternatives considered**:
- *Have the cycler skip children the queue has paused* — requires the cycler to read another module's private flag, and still leaves two writers. Rejected.
- *Leave the queue's pause alone and accept the interference* — silently degrades an existing feature. Rejected.

---

## R12 — Wall-clock timeouts under a duty cycle

**Decision**: Every wall-clock budget covering managed work is divided by `dutyOnFraction` while a limit is in force. The governor exposes `scaleTimeout(ms)` and the affected call sites use it.

**Rationale**: This is the failure mode that would otherwise reach users as random, unreproducible errors. Throttling stretches wall-clock duration by roughly `1 / dutyOnFraction` — at 20%, five-fold — but these budgets are all real-time deadlines, not CPU-time deadlines:

| Budget | Location | At 20% |
|---|---|---|
| `RENDER_TIMEOUT_MS = 90_000` | `landing-preview/renderer.ts:12,89` (`AbortSignal.timeout`) | A 25 s render becomes ~125 s → `RENDER_TIMEOUT` |
| `NAVIGATION_TIMEOUT_MS = 20_000` | `landing-preview/renderer.ts:10,112-113` | Navigation on a throttled browser trips it |
| `SIGKILL` escalation `2000` | `queue/queue.ts:688` | Compounds with R11 — see above |
| `FS_OP_TIMEOUT_MS = 15_000` | `landing-preview/scanner.ts:15` | Only if the op is behind managed work |
| `RENDER_TIMEOUT` watchdog | `team-bridge/landing-gallery.ts:52` | Same as the renderer |

FR-010 says throttling must not cause in-flight work to fail. An unscaled deadline turns the throttle into exactly that, and the symptom ("landing previews sometimes fail on this machine") points nowhere near the power lever.

**Alternatives considered**:
- *Suspend the timers alongside the process* — conceptually cleanest, but `AbortSignal.timeout` is not pausable and the timers live in modules that do not know about the governor. Rejected as more invasive for the same outcome.
- *Raise every timeout to its worst case (×5)* — a genuinely hung render would then take 7.5 minutes to fail even at full power. Rejected.

---

## R13 — "Unrestricted" must mean "exactly as today"

**Decision**: At `limitPercent === 100` the agent passes **no** new thread arguments and applies **no** priority change — the argv is byte-identical to what ships today. Thread arguments appear only when a limit is actually in force.

**Rationale**: The default is unrestricted (FR-011), so the overwhelming majority of users will run the code paths this feature adds without ever opening the panel. Those users must see no behaviour change at all. Naively deriving arguments from the budget at 100% would change two things:

- **whisper** currently defaults to `Math.max(4, os.cpus().length - 2)` (`whisper/transcriber.ts:333`) — 8 threads on a 10-core machine. A 100% budget would hand it 10, making transcription *hotter* by default than before this feature shipped.
- **FFmpeg** currently passes no `-threads` at all, leaving its own per-codec auto-detection in charge. Injecting `-threads <cores>` is not equivalent to that default, and quietly changes encoder behaviour for everyone.

Shipping a feature whose off state is not the previous state is how a "safe" default becomes a regression report. `-threads 0` is an acceptable alternative to omitting the flag, since FFmpeg reads it as "auto", but omission is simpler to verify.

---

## Summary of decisions

| # | Question | Decision |
|---|---|---|
| R1 | What does "resources" mean | CPU, as a share of total system capacity |
| R2 | Cap already-running work | Duty-cycle the tracked process tree; threads + priority at spawn |
| R3 | Windows has no SIGSTOP | Long-lived PowerShell `NtSuspendProcess` helper; `processPause` becomes true on win32 |
| R4 | Native addon? | No — no new dependency in v1; Job Objects noted as the long-term Windows upgrade |
| R5 | Measure consumption | Δ cumulative CPU time ÷ (Δ wall × cores), batched probe, only while watched |
| R6 | One shared budget, future-proof | Single `spawnManaged()` seam + ESLint ban on direct `child_process` |
| R7 | Entitlement | Gated, not exempt; UI degrades to the already-required unavailable state |
| R8 | Persistence | Agent-owned atomic `power.json`, per-machine, corrupt → default to unrestricted |
| R9 | Versioning | New tool contract `power: 1`; `AGENT_API_VERSION` unchanged |
| R10 | Floor behaviour | `max(1, …)` thread budget + duty-cycle on-window floor; overshoot on small machines documented |
| R11 | Who owns suspension | The governor, solely — the queue's estimate pause becomes `governor.hold()`; resume before every `SIGTERM` |
| R12 | Wall-clock deadlines | Scaled by `1 / dutyOnFraction` while limited, or throttling manufactures `RENDER_TIMEOUT` failures |
| R13 | What 100% means | Byte-identical argv to today — no thread flags, no priority change, when unrestricted |
