# Phase 1 Data Model: Local Agent Power Throttle

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

Field-level type signatures live in [contracts/shared-types.md](./contracts/shared-types.md); this document describes what the entities mean, how they relate, what constrains them, and how they move between states.

---

## Entity: Power Limit

The user's chosen ceiling. One value per machine.

| Attribute | Meaning | Constraint |
|---|---|---|
| `limitPercent` | Share of total system CPU capacity Soty may use | Integer, `POWER_LIMIT_MIN` (20) … `POWER_LIMIT_MAX` (100); `100` means unrestricted |
| `mode` | Derived, not stored | `'unrestricted'` when `limitPercent === 100`, else `'limited'` |
| `updatedAt` | When the value last changed | ISO-8601 string; diagnostics only, never drives behaviour |

**Validation** — one clamp helper (`clampPowerLimit`) is the single authority, per Principle I. It rounds to an integer and clamps into range. Every entry point uses it: the HTTP body parser, the persistence loader, and the governor's own setter. There is no second place where 20 or 100 appears as a literal.

**Default**: `100` (unrestricted) — for a user who has never set it (FR-011), and for any load that fails ([research R8](./research.md#r8--where-the-setting-lives-and-why-it-is-per-machine)).

**Persistence**: `power.json` in the application-support root, written temp + `rename`. Read is untrusted: parse failure, wrong shape, or out-of-range value → default, logged once.

---

## Entity: CPU Budget

Derived from the Power Limit; never stored. Recomputed whenever the limit changes.

| Attribute | Derivation | Consumed by |
|---|---|---|
| `threadBudget` | `max(1, round(limitPercent / 100 × os.cpus().length))`, or **`null` when unrestricted** | FFmpeg `-threads` / `-filter_threads`, whisper `-t` — at spawn time |
| `dutyOnFraction` | `limitPercent / 100` | The duty cycler's on-window within each 200 ms period |
| `priority` | `null` when unrestricted, a below-normal class otherwise | Applied once per child at spawn; never lowered back ([research R2](./research.md#r2--holding-a-ceiling-on-already-running-work)) |
| `timeoutScale` | `1 / dutyOnFraction` (so `1` when unrestricted) | `scaleTimeout(ms)`, applied to every wall-clock deadline covering managed work ([research R12](./research.md#r12--wall-clock-timeouts-under-a-duty-cycle)) |

**`null` is load-bearing, not a tidy default.** At 100% the budget deliberately produces *no* thread argument and *no* priority call, so the spawned argv is byte-identical to what ships today. A derived-but-equal-looking value would still change whisper's 8 threads to 10 and inject a `-threads` flag FFmpeg has never received — see [research R13](./research.md#r13--unrestricted-must-mean-exactly-as-today).

The `max(1, …)` floor is what guarantees FR-013 (throughput never reaches zero) and is the reason small machines overshoot the nominal limit — see [research R10](./research.md#r10--keeping-throughput-non-zero-at-the-floor).

**Relationship**: exactly one CPU Budget exists at a time, shared by every Managed Child. This *is* the mechanism behind FR-007 — there is no per-tool budget to diverge.

---

## Entity: Managed Child

One heavy child process the governor is accountable for. Created by `spawnManaged()`, destroyed on exit.

| Attribute | Meaning |
|---|---|
| `pid` | The direct child's PID |
| `toolId` | Which tool spawned it (`'compressor'`, `'transcription'`, …) — diagnostics and tests only; it never affects the budget |
| `descendants` | PIDs beneath it, refreshed on a slow cadence; non-empty in practice only for Playwright |
| `suspended` | Whether the child is currently stopped — **for any reason**; the governor is the only writer |
| `holds` | Outstanding hold handles taken by other subsystems (currently the queue's estimate prioritization). While non-empty the cycler leaves the child suspended and never resumes it |
| `startedAt` | For sampler delta bookkeeping |

**Suspension has exactly one owner.** No module outside the governor may call `pauseProcess`/`resumeProcess` on a managed child. Callers that need a child stopped for their own reasons take a hold:

```ts
const release = governor.hold(child, 'estimate-priority');
try { /* … */ } finally { release(); }
```

and callers that need it *running* — every cancel and shutdown path, before `SIGTERM` — call `governor.resumeForTermination(child)`, which resumes and pins the child resumed. Without that, `SIGTERM` is delivered to a stopped process that will not run its handler, FFmpeg never finalizes its output, and the 2 s escalation at `queue.ts:688` kills it outright. See [research R11](./research.md#r11--one-owner-of-suspend-state).

**Lifecycle**:

```
        spawnManaged()
              │
              ▼
   ┌──────────────────┐   limit < 100%    ┌──────────────┐
   │     running      │ ────────────────▶ │  cycling     │
   │  (unthrottled)   │ ◀──────────────── │ (suspend ⇄   │
   └──────────────────┘   limit = 100%    │   resume)    │
              │                            └──────────────┘
              │  child 'close' / 'error'          │
              └──────────────┬───────────────────┘
                             ▼
                       ┌───────────┐
                       │  released │  resumed if suspended, then deregistered
                       └───────────┘
```

The `cycling → released` edge is the dangerous one: a child must never be deregistered while stopped, or it is stopped forever. See [Invariants](#invariants).

---

## Entity: Consumption Sample

A point-in-time estimate of what Soty is using. Produced once per tick while at least one client is watching; broadcast, never stored.

| Attribute | Meaning | Constraint |
|---|---|---|
| `availability` | Whether a figure could be produced | `'ok'` \| `'unsupported'` \| `'error'` — a discriminated union, so a consumer cannot read a percentage that does not exist |
| `systemSharePercent` | Soty's share of total system capacity | Present only when `availability === 'ok'`; `0`–`100`, one decimal |
| `activity` | Whether Soty is doing work | `'idle'` \| `'active'` — `'active'` when a Managed Child is registered **or** any tool module reports `busy()` |
| `cpuCount` | Cores the share was computed against | For the UI to explain the figure if asked |
| `sampledAt` | Sample instant | ISO-8601 |

**Derivation**: `share% = (Δ cpu_time_seconds / (Δ wall_seconds × cpuCount)) × 100`, summed over the agent process (`process.cpuUsage()`) and every Managed Child plus its descendants. The **first** tick after sampling starts has no previous sample to difference against and is therefore emitted as `availability: 'unsupported'`-equivalent warm-up — the UI shows "measuring…" rather than a fabricated zero (FR-018).

The `busy()` half matters because a job in `preparing-images` or waiting on an estimate has no child process yet. Reading activity purely from the child registry would make the panel say "idle" while the compressor UI says "running" — the spec's own definition is "no local job is running", not "no process exists".

**Why a union rather than a nullable number**: `systemSharePercent: number | null` would let a caller render `null` as `0%`, which is exactly the "stale or invented value" FR-018 forbids. The union forces the caller to branch.

---

## Entity: Power State

The snapshot both HTTP routes return and every SSE frame carries. This is the one shape the web reads.

| Attribute | Source |
|---|---|
| `limitPercent` | Power Limit |
| `mode` | Derived from the limit |
| `sample` | Latest Consumption Sample, or a warm-up sample |
| `throttlingSupported` | Whether this host can throttle running work — `capabilities().processPause` |
| `activeChildren` | Count of Managed Children; drives the idle/active wording |

**Relationships**:

```
PowerState ──1:1── PowerLimit ──derives──▶ CpuBudget ──applies to──▶ ManagedChild (0..n)
     │                                                                     │
     └──1:1── ConsumptionSample ◀─────────── sampled from ─────────────────┘
                                             (+ the agent process itself)
```

---

## State transitions

### Limit change

```
POST /api/power/limit { limitPercent }
        │
        ├─ parse fails / out of range ──▶ 400 { error: 'POWER_LIMIT_INVALID' }   (state unchanged)
        │
        └─ clamped value
              │
              ├─▶ persist power.json (atomic)          ── failure ──▶ 500 { error: 'POWER_PERSIST_FAILED' }
              │                                                        (in-memory value NOT applied — the
              │                                                         lever must never show a limit that
              │                                                         will not survive a restart, FR-006)
              │
              ├─▶ recompute CpuBudget
              ├─▶ retune the duty cycler          ← this is what reaches running work, FR-009
              ├─▶ broadcast PowerState on the SSE channel   ← this is what gives FR-023 for free
              └─▶ 200 PowerState
```

Newly spawned children pick up the new budget at spawn; running children are reached by the cycler. Both paths are covered within the 5 s FR-009 budget — the cycler retunes on its next period (≤ 200 ms).

### Sampling lifecycle

```
subscribers 0 ──first SSE client connects──▶ subscribers 1 ──▶ start 1 s tick
                                                                    │
subscribers 1 ──last SSE client disconnects──▶ subscribers 0 ──▶ stop tick   (FR-019)
```

The tick timer is `.unref()`'d so it can never hold the process open (Principle IV).

### Throttling engagement

```
limit = 100%  ──▶  cycler idle, no signals sent, children run free
limit < 100%  ──▶  cycler active on a 200 ms period
                    on-window  = max(50 ms, 200 ms × limit/100)
                    off-window = 200 ms − on-window
```

At `limitPercent = 100` the cycler must be genuinely inactive, not "suspending for 0 ms" — a zero-length off-window would still cost two signals per period per PID for no benefit.

---

## Invariants

These are the properties that must hold no matter what fails; each names the test that proves it.

1. **No child is ever left suspended.** Every path that removes a Managed Child resumes it first — normal exit, error, cancellation, agent shutdown, and the governor's own failure paths. Agent shutdown resumes all tracked PIDs *before* the process exits.
   → `tests/power-governor.test.ts` — "resumes every suspended child on shutdown"

2. **Deregistration is unconditional.** Registration and removal are paired in a `finally`, so a throwing tool cannot leak an entry that the cycler will keep signalling — eventually at a PID the OS has recycled onto an unrelated process.
   → `tests/power-governor.test.ts` — "deregisters on spawn error and on non-zero exit"

3. **A PID is signalled only while it is known-live.** The cycler skips any child whose `close` has fired, guarding the recycled-PID hazard.
   → `tests/power-governor.test.ts` — "never signals a PID after its close event"

4. **One budget, shared.** Two concurrent children see the same `threadBudget` and one shared duty cycle; the aggregate is bounded by the limit, not by limit-per-tool.
   → `tests/power-governor.test.ts` — "two concurrent children share one budget"

5. **The persisted limit and the applied limit never diverge.** A persistence failure leaves the in-memory limit unchanged and returns an error, so the lever always reflects reality (FR-006).
   → `tests/power-persistence.test.ts` — "does not apply a limit it could not persist"

6. **A corrupt store never yields a nonsense limit.** Unparseable, wrong-shaped, or out-of-range `power.json` → default 100%, logged once.
   → `tests/power-persistence.test.ts` — "falls back to unrestricted on corrupt state"

7. **No sample is invented.** Before two ticks exist, or when the platform probe fails, the state carries a non-`ok` availability and no percentage (FR-018).
   → `tests/power-sampler.test.ts` — "reports unavailable rather than zero before the first delta"

8. **Every heavy spawn is managed.** No module outside `platform/` and `power/` imports `node:child_process`.
   → `tests/power-spawn-coverage.test.ts` + the ESLint `no-restricted-imports` rule

9. **Throughput is never zero.** At the minimum limit the thread budget is ≥ 1 and the duty on-window is ≥ 50 ms (FR-013).
   → `tests/power-governor.test.ts` — "floors the budget on a low-core machine"

10. **The governor is the only writer of suspend state.** A child under an outstanding hold is never resumed by the duty cycler, and no module outside the governor calls `pauseProcess`/`resumeProcess` on a managed child ([research R11](./research.md#r11--one-owner-of-suspend-state)).
    → `tests/power-governor.test.ts` — "duty cycler does not resume a child under hold"
    → `tests/power-spawn-coverage.test.ts` — "no direct pauseProcess/resumeProcess outside power/ and platform/"

11. **No `SIGTERM` is ever sent to a stopped child.** Every cancel and shutdown path resumes first and pins the child resumed, so the graceful-termination window is real and FFmpeg can finalize its output.
    → `tests/power-governor.test.ts` — "resumes and pins before termination"
    → `tests/power-queue-integration.test.ts` — "cancelling a duty-suspended encode still exits gracefully"

12. **Unrestricted is indistinguishable from today.** At 100% the spawned argv contains no thread flag, no priority call is made, and `scaleTimeout(ms) === ms` (FR-011, [research R13](./research.md#r13--unrestricted-must-mean-exactly-as-today)).
    → `tests/power-governor.test.ts` — "adds no arguments and no priority call when unrestricted"

13. **Wall-clock deadlines survive throttling.** Every managed-work timeout is scaled by `1 / dutyOnFraction`, so a limit slows work down without failing it (FR-010, [research R12](./research.md#r12--wall-clock-timeouts-under-a-duty-cycle)).
    → `tests/power-timeout-scaling.test.ts` — "render budget scales with the duty cycle"

14. **The limit governs local processing only.** Network transfers, the agent's own HTTP handling, and remote work are never throttled (FR-020).
    → `tests/power-scope.test.ts` — "transfers and agent responsiveness stay outside the budget"

---

## Key entity ↔ requirement map

| Spec entity | Modelled as | Requirements satisfied |
|---|---|---|
| Power Limit | `PowerLimit` + `clampPowerLimit` + `power.json` | FR-003, FR-011, FR-012, FR-013 |
| Local Tool | Managed Child registered via `spawnManaged` | FR-007, FR-008 |
| Consumption Sample | `PowerSample` discriminated union | FR-015, FR-016, FR-017, FR-018, FR-019 |
| — | `PowerState` snapshot over SSE | FR-005, FR-006, FR-009, FR-023 |
| — | CPU Budget (threads + duty + priority + timeout scale) | FR-007, FR-009, FR-010, FR-013, FR-014 |
| — | Hold / resume-for-termination protocol | FR-010 |
| — | Scope boundary: only managed children are governed | FR-020 |
